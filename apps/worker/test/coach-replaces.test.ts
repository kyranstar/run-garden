/**
 * A FOLLOW-UP REPLACES WHAT IT CHANGES (the new shape §5; stream A, part 4). In a conversation, a reply that changes an
 * open suggestion — "make it 10 minutes", "evening instead" — says so: `propose_workout({ …, replaces: proposalId })`.
 * It must name an open single-workout suggestion of the athlete's in this conversation: pending, nothing in it decided,
 * one designed workout and no change to the plan, never a set's, never this run's own — else it is refused in words,
 * writing nothing. The name rides on the draft's op (`supersedes`), through its revisions, and the suggestion is
 * superseded when the new one is made pending, by the finish's own supersede (design-orchestrate.ts
 * `supersedeOlderPlans`: only while both are pending, never a set's) with the athlete's words as the reason. No statement
 * more: the named suggestion is read with the athlete.
 *
 * The real registry, opening context and loop, driven by a scripted model; no key, no network. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { cancelRun, createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { supersedeOlderPlans } from "../src/services/design-orchestrate.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext, type ToolErr } from "../src/services/design-tools/types.js";
import type { ContentBlock, MessagesOk, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedOtherAthlete, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
let statements = 0;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await seedRichAthlete(db));
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_rp${++seq}`, name, input });
const turn = (...uses: ContentBlock[]): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});
const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (mustFix: string[] = []) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, mustFix.length ? 2 : 4])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: noted.`])),
  mustFix,
  improvements: [],
});
const propose = (title: string, extra: Record<string, unknown> = {}) =>
  use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date: TODAY }, ...extra });

function deps(turns: MessagesResult[]): RunDeps {
  return {
    callModel: async () => {
      const next = turns.shift();
      if (!next) throw new Error("the scripted model ran out of turns");
      return next;
    },
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
}

async function asked(words: string, turns: MessagesResult[], at: number, extra: { conversationId?: string | null } = {}) {
  const run = await createRun(db, userId, { request: words, ...extra }, new Date(NOW.getTime() + at * 1000));
  const d = deps(turns);
  let status = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, run.run.id, userId, new Date(NOW.getTime() + (at + i + 1) * 1000), d);
      if (out.kind !== "ok") throw new Error(out.kind);
      status = out.result.status;
      return status !== "active";
    },
    { max: 30, what: "drive" },
  );
  return { id: run.run.id, conversationId: run.conversationId, status };
}

const proposalOf = async (runId: string) => {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as Array<DocWorkoutOp & { outcome?: Record<string, unknown>; supersedes?: string }> } : undefined;
};

/** The first suggestion of a conversation: "Calm hips", pending. */
async function first() {
  const a = await asked("Something calm for my hips.", [turn(propose("Calm hips")), turn(use("submit_review", verdict())), turn(use("finish", { summary: "Calm hips, ready." }))], 0);
  expect(a.status).toBe("finished");
  expect((await proposalOf(a.id))!.status).toBe("pending");
  return a;
}

describe("a follow-up names the suggestion it changes", () => {
  it("in the conversation: the new suggestion replaces it once it is ready, with the athlete's words as why", async () => {
    const a = await first();
    const b = await asked(
      "Make it ten minutes.",
      [turn(propose("Calm hips, ten minutes", { replaces: designProposalId(a.id) })), turn(use("submit_review", verdict())), turn(use("finish", { summary: "Shorter." }))],
      100,
    );
    expect(b.conversationId).toBe(a.id);
    expect(b.status).toBe("finished");
    const old = (await proposalOf(a.id))!;
    expect(old.status).toBe("superseded");
    expect(old.ops[0]!.outcome).toMatchObject({ status: "superseded", reason: "Changed: Make it ten minutes.", by: designProposalId(b.id) });
    const neu = (await proposalOf(b.id))!;
    expect(neu.status).toBe("pending");
    expect(neu.ops[0]!.supersedes).toBe(designProposalId(a.id));
  });

  it("a revision keeps what its first draft named", async () => {
    const a = await first();
    const b = await asked(
      "Make it ten minutes.",
      [
        turn(propose("Calm hips, ten minutes", { replaces: designProposalId(a.id) })),
        turn(use("submit_review", verdict(["Swap the dead bugs for bird dogs."]))),
        turn(propose("Calm hips, ten minutes, again", { changeNote: "Bird dogs in." })),
        turn(use("submit_review", verdict())),
        turn(use("finish", { summary: "Shorter." })),
      ],
      100,
    );
    expect(b.status).toBe("finished");
    expect((await proposalOf(b.id))!.ops[0]!.supersedes).toBe(designProposalId(a.id));
    expect((await proposalOf(a.id))!.status).toBe("superseded");
  });

  it("an amend that names it keeps it: the reviewed draft's text fixed, the suggestion it changes named", async () => {
    const a = await first();
    const b = await asked(
      "Make it ten minutes.",
      [
        turn(propose("Calm hips, ten minutes")),
        turn(use("submit_review", verdict())),
        turn(propose("Calm hips, ten short minutes", { amend: true, changeNote: "A clearer title.", replaces: designProposalId(a.id) })),
        turn(use("finish", { summary: "Shorter." })),
      ],
      100,
    );
    expect(b.status).toBe("finished");
    const neu = (await proposalOf(b.id))!;
    expect([neu.ops[0]!.doc.title, neu.ops[0]!.supersedes]).toEqual(["Calm hips, ten short minutes", designProposalId(a.id)]);
    expect((await proposalOf(a.id))!.status).toBe("superseded");
  });

  it("only while both are pending: one approved meanwhile is left alone", async () => {
    const a = await first();
    const pid = designProposalId(a.id);
    const at = NOW.toISOString();
    const newer = `dp-x-${a.id}`;
    await db.insert(schema.coachProposals).values({
      id: newer, userId, planId: null, title: "Newer", evidence: "", rationale: "", flags: [], status: "pending",
      ops: [{ kind: "doc_workout", target: { kind: "new", date: "2026-05-20" }, date: "2026-05-20", doc: calmDoc(), review: null, issues: [], derived: {}, by: { runId: "x", role: "main" }, toolUseId: "t", at, supersedes: pid }],
      createdAt: new Date(NOW.getTime() + 60_000).toISOString(), expiresAt: "2026-05-20",
    });
    await db.update(schema.coachProposals).set({ status: "approved" }).where(eq(schema.coachProposals.id, pid));
    expect(await supersedeOlderPlans(db, userId, newer, at)).toBe(0);
    await db.update(schema.coachProposals).set({ status: "pending" }).where(eq(schema.coachProposals.id, pid));
    expect(await supersedeOlderPlans(db, userId, newer, at)).toBe(1);
    expect((await proposalOf(a.id))!.ops[0]!.outcome).toMatchObject({ status: "superseded", reason: "Changed." });
  });
});

describe("refused in words, writing nothing, unless it names an open single-workout suggestion of this conversation", () => {
  /** A ToolContext for a main auto run of `conversationId` (no review hooks: a draft is stored unreviewed). */
  async function ctxIn(conversationId: string, role: "main" | "designer" = "main"): Promise<ToolContext> {
    const run = await createRun(db, userId, { request: "Change it.", conversationId }, new Date(NOW.getTime() + 500_000));
    await cancelRun(db, userId, run.run.id, new Date(NOW.getTime() + 500_001));
    return {
      db, env, userId, now: NOW, toolUseId: `call-${newId()}`,
      run: { id: role === "main" ? run.run.id : `d-${run.run.id}`, role, scope: role === "main" ? { kind: "auto" } : { kind: "week" }, parentId: role === "main" ? null : run.run.id, rehearsal: false, conversationId: run.conversationId },
    };
  }
  const refusal = async (ctx: ToolContext, replaces: string): Promise<ToolErr> => {
    const out = await proposeWorkout.run(ctx, { doc: calmDoc({ title: "Changed" }), target: { kind: "new", date: TODAY }, replaces });
    expect(isToolErr(out), JSON.stringify(out)).toBe(true);
    return out as ToolErr;
  };
  const insertSuggestion = async (runId: string, o: { status?: string; ops?: unknown[]; scope?: unknown; conversationId?: string; user?: string } = {}) => {
    const owner = o.user ?? userId;
    await db.insert(schema.coachRuns).values({
      id: runId, userId: owner, parentId: null, role: "main", scope: (o.scope ?? { kind: "auto" }) as Record<string, unknown>, request: "x", status: "finished",
      state: JSON.stringify({ v: 1, settings: { ceilingMicros: 1, maxCalls: 1, effort: "high", maxTokens: 1, rehearsal: false, conversationId: o.conversationId ?? runId }, system: null, messages: [] }),
      steps: 1, costUsd: 0, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), finishedAt: NOW.toISOString(),
    });
    const op = { kind: "doc_workout", target: { kind: "new", date: TODAY }, date: TODAY, doc: calmDoc(), review: null, issues: [], derived: {}, by: { runId, role: "main" }, toolUseId: "t", at: NOW.toISOString() };
    await db.insert(schema.coachProposals).values({
      id: designProposalId(runId), userId: owner, planId: null, title: "T", evidence: "", rationale: "", flags: [], status: o.status ?? "pending",
      ops: (o.ops ?? [op]) as unknown[], createdAt: NOW.toISOString(), expiresAt: TODAY,
    });
    return { id: designProposalId(runId), op };
  };

  it("each wrong name is refused, plainly, and no draft is stored", async () => {
    const a = await first();
    const ctx = await ctxIn(a.id);
    const change = { kind: "plan_adjust", id: "adj-w", op: { kind: "skip", workoutId: "w" }, why: "x", issues: [], date: TODAY, row: {}, toolUseId: "t2", at: NOW.toISOString() };
    const cases: Array<[string, string]> = [
      ["unknown", "dp-nothing"],
      ["not a suggestion", `${userId}-prop-6`],
      ["another conversation's", (await insertSuggestion(newId())).id],
      ["approved", (await insertSuggestion(newId(), { status: "approved", conversationId: a.id })).id],
      ["partly approved", (await insertSuggestion(newId(), { status: "partially_approved", conversationId: a.id })).id],
      ["with a change", (await insertSuggestion(newId(), { conversationId: a.id, ops: [(await insertSuggestion(newId())).op, change] })).id],
      ["a set's", (await insertSuggestion(newId(), { conversationId: a.id, scope: { kind: "week" } })).id],
      ["its own", designProposalId(ctx.run.id)],
    ];
    const other = await seedOtherAthlete(db);
    cases.push(["another athlete's", (await insertSuggestion(newId(), { user: other.userId, conversationId: a.id })).id]);
    for (const [what, id] of cases) {
      const e = await refusal(ctx, id);
      expect(e.error, what).toBe("replaces_not_open");
      expect(e.why, what).toMatch(/replaces/);
      expect(e.fix, what).toMatch(/Leave replaces out/);
    }
    // Its own is named as its own: the draft is revised, never replaced.
    expect((await refusal(ctx, designProposalId(ctx.run.id))).why).toMatch(/this design's own suggestion — revise your draft instead/);
    expect(await proposalOf(ctx.run.id)).toBeUndefined();
    // The conversation's own open suggestion is taken.
    const ok = await proposeWorkout.run(ctx, { doc: calmDoc({ title: "Changed" }), target: { kind: "new", date: TODAY }, replaces: designProposalId(a.id) });
    expect(isToolErr(ok), JSON.stringify(ok)).toBe(false);
    expect((await proposalOf(ctx.run.id))!.ops[0]!.supersedes).toBe(designProposalId(a.id));
    // A later draft of the run's that names none keeps the name its first gave (no review here: the draft is replaced).
    const again = await proposeWorkout.run({ ...ctx, toolUseId: "call-again" }, { doc: calmDoc({ title: "Changed again" }), target: { kind: "new", date: TODAY } });
    expect(isToolErr(again), JSON.stringify(again)).toBe(false);
    const [op] = (await proposalOf(ctx.run.id))!.ops;
    expect([op!.doc.title, op!.supersedes]).toEqual(["Changed again", designProposalId(a.id)]);
  });

  it("a set's designer never names one", async () => {
    const a = await first();
    const e = await refusal(await ctxIn(a.id, "designer"), designProposalId(a.id));
    expect(e.error).toBe("not_for_role");
  });

  it("costs no statement more: the suggestion is read with the athlete", async () => {
    const a = await first();
    const ctx = await ctxIn(a.id);
    statements = 0;
    await proposeWorkout.run({ ...ctx, toolUseId: "c1" }, { doc: calmDoc({ title: "Plain" }), target: { kind: "new", date: TODAY } });
    const plain = statements;
    await db.delete(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(ctx.run.id)));
    statements = 0;
    await proposeWorkout.run({ ...ctx, toolUseId: "c2" }, { doc: calmDoc({ title: "Named" }), target: { kind: "new", date: TODAY }, replaces: designProposalId(a.id) });
    expect(statements).toBe(plain);
    expect(statements).toBeLessThanOrEqual(proposeWorkout.statementCost);
  });
});
