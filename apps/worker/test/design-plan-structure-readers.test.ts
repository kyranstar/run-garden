/**
 * A WHOLE PLAN CHANGE THROUGH EVERY READER (§8 §5, stream W): the conversation coach's `plan_structure` op, propose_plan's,
 * through the real loop (a scripted model, no key: its ceiling raised once, never a set's run) and every reader of a
 * designed proposal — the conversation's cards and its block for a later turn, read_proposals, the opening context's open
 * suggestions and its focus block, the current run's pick, the thread coach's dossier, and export's rows. Synthetic data
 * only: the made-up athlete of design-read-fixture.ts, on its fixed clock (today Wed 13 May 2026).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { buildDossier } from "../src/services/coach-context.js";
import { conversationBlock, conversationRows, namedConversationSql, readConversation } from "../src/services/coach-conversation.js";
import { createRun, currentRun, endedLine, LINES, RUN_CEILING_MICROS, runStep, type RunDeps, type RunSettings } from "../src/services/coach-runs.js";
import { COACH_RUN_SET_WINDOW_HOURS } from "../src/services/cron-limits.js";
import { buildDesignContext, designContextBuilder } from "../src/services/design-context.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr, type ToolOk } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult, ToolResultBlock } from "../src/services/llm-messages.js";
import type { PlanStructureOp } from "../src/services/proposal-kinds.js";
import { NOW, seedRichAthlete } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", COACH_DESIGNER: "1" } as Env;

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await seedRichAthlete(db));
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_psr${++seq}`, name, input });
const turn = (...uses: ContentBlock[]): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});

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

function sent(requests: MessagesRequest[], call: ContentBlock): { is_error?: boolean; body: any } {
  for (const r of requests) {
    for (const m of r.messages) {
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const b of m.content) {
        if (b.type === "tool_result" && b.tool_use_id === (call as { id: string }).id) {
          const t = b as ToolResultBlock;
          return { is_error: t.is_error, body: JSON.parse(typeof t.content === "string" ? t.content : JSON.stringify(t.content)) };
        }
      }
    }
  }
  throw new Error("no result sent");
}

async function drive(runId: string, deps: RunDeps, from = 0) {
  let last = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + (from + i + 1) * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      last = out.result.status;
      return last !== "active";
    },
    { max: 60, what: "drive" },
  );
  return last;
}

const stateOf = async (id: string) => {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return JSON.parse(row!.state!) as { settings: RunSettings & Record<string, unknown> };
};
const proposalOf = async (runId: string) => (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId))))[0]!;

const easy = (minutes: number, title = "Easy run") => ({ category: "easy", title, durationMinutes: minutes, run: { blocks: [{ kind: "duration", value: minutes, intensity: "easy" }] } });
const tenK = {
  kind: "createPlan",
  discipline: "run",
  name: "10K build",
  startDate: "2026-05-18",
  endDate: "2026-06-14",
  raceDate: "2026-06-14",
  firmSessions: [
    { date: "2026-05-18", session: easy(40) },
    { date: "2026-05-20", session: easy(45, "Steady run") },
    { date: "2026-05-24", session: { category: "long", title: "Long run", durationMinutes: 75, run: { blocks: [{ kind: "duration", value: 75, intensity: "easy" }] } } },
  ],
  shapeWeeks: ["2026-05-25", "2026-06-01", "2026-06-08"].map((weekStart) => ({ weekStart, volumeTarget: "about 30 km", keySessions: ["long run"] })),
};

/** An auto run that reads the plans, proposes a block and finishes: its id, the calls and the requests. */
async function planned(words = "Plan my next four weeks toward a 10K") {
  const run = await createRun(db, userId, { request: words }, NOW);
  const read = use("read_plans", {});
  const plan = use("propose_plan", { change: tenK, why: "Four weeks that build to your 10K." });
  const { deps, requests } = scripted([turn(read), turn(plan), turn(use("finish", { summary: "Here's a four-week build toward your 10K." }))]);
  expect(await drive(run.run.id, deps)).toBe("finished");
  return { id: run.run.id, plan, requests };
}

describe("through the loop", () => {
  it("an auto run reads the plans and proposes a block: its ceiling raised to a set's once, with a set's window — never a set's run — and its proposal the athlete's at the finish", async () => {
    const { id, plan, requests } = await planned();
    expect(sent(requests, plan).is_error).toBeFalsy();
    const settings = (await stateOf(id)).settings;
    expect(settings.ceilingMicros).toBe(RUN_CEILING_MICROS.week);
    expect(typeof settings.planRaisedAt).toBe("string");
    expect(settings.raisedAt).toBeUndefined();
    expect(settings.window).toEqual({ kind: "until", at: new Date(Date.parse(settings.planRaisedAt!) + COACH_RUN_SET_WINDOW_HOURS * 3_600_000).toISOString() });
    // An expiry of such a run is said as a set's (its window is one), never as a day's.
    expect(endedLine("expired", "expired", settings)).toBe(LINES.expiredSet);
    const p = await proposalOf(id);
    expect(p.status).toBe("pending");
    expect((p.ops as PlanStructureOp[]).map((o) => [o.kind, o.title])).toEqual([["plan_structure", "10K build"]]);
  });

  it("a second plan in a later turn keeps the first raise", async () => {
    const run = await createRun(db, userId, { request: "Plan my next four weeks" }, NOW);
    const first = use("propose_plan", { change: tenK, why: "First." });
    const ask = use("ask_athlete", { questions: [{ text: "Four or five days a week?", chips: ["Four", "Five"], why: "It sets the week." }] });
    const { deps } = scripted([turn(first), turn(ask)]);
    expect(await drive(run.run.id, deps)).toBe("waiting_athlete");
    const raised = (await stateOf(run.run.id)).settings.planRaisedAt;
    const again = use("propose_plan", { change: { ...tenK, name: "10K build, five days" }, why: "Second." });
    const later = scripted([turn(again), turn(use("finish", { summary: "Five days it is." }))]);
    const { answerRun } = await import("../src/services/coach-runs.js");
    await answerRun(db, userId, run.run.id, { answers: ["Five"] }, new Date(NOW.getTime() + 60_000));
    expect(await drive(run.run.id, later.deps, 100)).toBe("finished");
    expect((await stateOf(run.run.id)).settings.planRaisedAt).toBe(raised);
    expect(((await proposalOf(run.run.id)).ops as PlanStructureOp[])[0]!.title).toBe("10K build, five days");
  });
});

describe("the conversation", () => {
  it("a plan is one card of its own — its title, its line, its lines — and a later turn's block names it with its id and how it stands", async () => {
    const { id } = await planned();
    const conv = await readConversation(db, userId, new Date(NOW.getTime() + 120_000), { endedLine });
    const card = conv.turns.at(-1)!.cards;
    expect(card).toEqual([
      {
        kind: "plan",
        proposalId: designProposalId(id),
        title: "10K build",
        summary: "4 weeks · 3 sessions to start · race Sun 14 Jun",
        status: "pending",
        lines: ((await proposalOf(id)).ops as PlanStructureOp[])[0]!.lines,
      },
    ]);
    expect(card[0]!.lines![0]).toMatch(/^New plan: 10K build · Mon 18 May to Sun 14 Jun/);
    const rows = await conversationRows(db, userId, namedConversationSql(userId, id), { limit: 6 });
    const block = conversationBlock(rows, new Date(NOW.getTime() + 120_000))!;
    expect(block).toContain(`Suggested a plan (id ${designProposalId(id)}): ${markUntrusted("main coach", "10K build")} · ${markUntrusted("main coach", "4 weeks · 3 sessions to start · race Sun 14 Jun")} — still open`);
    // Being added: said so.
    const p = await proposalOf(id);
    const applying = (p.ops as PlanStructureOp[]).map((o) => ({ ...o, outcome: { status: "applying", at: NOW.toISOString(), progress: { step: "sessions", done: 2 } } }));
    await db.update(schema.coachProposals).set({ ops: applying }).where(eq(schema.coachProposals.id, p.id));
    const again = conversationBlock(await conversationRows(db, userId, namedConversationSql(userId, id), { limit: 6 }), new Date(NOW.getTime() + 120_000))!;
    expect(again).toContain("— being added, part of it already on the plan");
  });
});

describe("the coach's other readers", () => {
  it("read_proposals: the plan by its change, title and line, the why marked — and how it ended, with what was added", async () => {
    const { id } = await planned();
    const read = async () => {
      const res = await readProposals.run({ db, env, userId, run: { id: "r", role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW }, {});
      if (isToolErr(res)) throw new Error(res.why);
      return ((res as ToolOk).data as { proposals: Array<{ id: string; ops: Array<Record<string, unknown>> }> }).proposals.find((x) => x.id === designProposalId(id))!;
    };
    expect((await read()).ops).toEqual([
      {
        kind: "plan_structure",
        change: "createPlan",
        date: "2026-05-18",
        day: "Mon 18 May · in 5 d",
        title: { untrusted: true, text: "10K build" },
        summary: { untrusted: true, text: "4 weeks · 3 sessions to start · race Sun 14 Jun" },
        why: { untrusted: true, text: "Four weeks that build to your 10K." },
      },
    ]);
    const p = await proposalOf(id);
    const done = (p.ops as PlanStructureOp[]).map((o) => ({ ...o, outcome: { status: "applied", at: NOW.toISOString(), summary: "Added “10K build” with 3 sessions" } }));
    await db.update(schema.coachProposals).set({ ops: done, status: "approved" }).where(eq(schema.coachProposals.id, p.id));
    expect((await read()).ops[0]).toMatchObject({ outcome: "approved", added: { untrusted: true, text: "Added “10K build” with 3 sessions" } });
  });

  it("the opening context: the plan among the open suggestions, and asked from it, its line in the focus block", async () => {
    const { id } = await planned();
    const ctx = await buildDesignContext(db, env, userId, { id: "run-next", role: "main", scope: { kind: "auto" }, request: "Make it gentler", parentId: null, focus: { kind: "proposal", id: designProposalId(id) } }, NOW);
    expect(ctx.header).toMatch(/- open suggestions: [^\n]*10K build/);
    expect(ctx.header).toContain(`- a plan (createPlan): ${markUntrusted("designer run", "10K build · 4 weeks · 3 sessions to start · race Sun 14 Jun")} — open`);
  });

  it("the current run's pick holds the run while its plan is open; the thread coach's dossier names it as a plan change", async () => {
    const { id } = await planned();
    const current = await currentRun(db, userId, new Date(NOW.getTime() + 120_000));
    expect(current?.run.id).toBe(id);
    expect(current?.proposal?.id).toBe(designProposalId(id));
    const dossier = await buildDossier(db, userId, await loadPreferences(db, userId), "2026-05-13");
    expect(JSON.stringify(dossier)).toContain(`pending proposal [${designProposalId(id)}]: 10K build (a plan change: 10K build, waiting for the athlete in the Studio)`);
  });

  it("a follow-up never replaces a suggestion holding a plan (propose_workout's replaces is for one workout alone)", async () => {
    const { id } = await planned();
    const run = await createRun(db, userId, { request: "Something for my hips today" }, new Date(NOW.getTime() + 600_000));
    const draft = use("propose_workout", { doc: calmDoc({ title: "Hips, gently" }), target: { kind: "new", date: "2026-05-14" }, replaces: designProposalId(id) });
    const { deps, requests } = scripted([turn(draft), turn(use("finish", { summary: "x" }))]);
    await drive(run.run.id, deps, 700);
    const res = sent(requests, draft);
    expect(res.is_error).toBe(true);
    expect(res.body.error).toBe("replaces_not_open");
    expect(res.body.why).toMatch(/isn't one workout alone/);
    void newId;
  });
});
