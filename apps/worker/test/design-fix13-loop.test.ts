/**
 * TASK 13'S FIX WAVE, THE LOOP (stream S1): how a run ends and what its trail says after the live suite.
 *
 *  - R3: a last-turn finish is never lost to its length — and a tool refused on the run's last call ends the run as a
 *    finish in words does (the proposal promoted, the model's words or the standard line), never as a stop.
 *  - §2.1: the last turn's note states the line's cap in words; a long finish line is clipped where the athlete reads it
 *    and kept whole in the event's payload.
 *
 * The real registry, the real opening context and the real loop, driven by one scripted model shared by every run of
 * the tree. No key, no network. Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, LAST_TURN_NOTE, LINES, readRunState, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, type DocWorkoutOp } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
beforeAll(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_l${++seq}`, name, input });
function turn(uses: ContentBlock[], text = "Working on it."): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 50, outputTokens: 40 },
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
  const all: Array<{ status: string }> = [];
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, runId, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      all.push(out.result);
      return out.result.status !== "active";
    },
    { max: 60, what: "drive" },
  );
  return all;
}

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])),
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])),
  mustFix: [],
  improvements: [],
});
const propose = (title: string) => use("propose_workout", { doc: calmDoc({ title }), target: { kind: "new", date: TODAY } });
const submit = (v: unknown) => use("submit_review", v);

/** A now run whose step cap is `maxCalls` model calls (its state changed as a lowered setting would). */
async function nowRun(userId: string, maxCalls: number): Promise<string> {
  const id = (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  const state = readRunState(row!.state)!;
  state.settings.maxCalls = maxCalls;
  await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
  return id;
}

async function trail(runId: string) {
  return db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId)).orderBy(schema.coachRunEvents.seq);
}
async function proposalOf(runId: string) {
  const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  return p ? { ...p, ops: p.ops as DocWorkoutOp[] } : undefined;
}
async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}

describe("R3: the last turn never loses a finished design", () => {
  it("a last-turn finish of 500 characters ends the run finished: the proposal pending, the line clipped at a sentence, the whole kept", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const long = `${"Calm hips at home, slow holds first and the trunk after. ".repeat(8)}Enjoy it.`.slice(0, 500);
    const { deps, requests } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(use("finish", { summary: long }))]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    // The finish was the run's last call, told so — with the line's cap in words.
    expect(JSON.stringify(requests.at(-1)!.messages.at(-1))).toContain(LAST_TURN_NOTE);
    expect(LAST_TURN_NOTE).toContain("at most about 45 words (300 characters)");
    expect(await runRow(runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    expect((await proposalOf(runId))!.status).toBe("pending");
    const last = (await trail(runId)).at(-1)!;
    expect(last.summary.length).toBeLessThanOrEqual(300);
    expect(last.summary).toMatch(/\.$/);
    expect(long.startsWith(last.summary)).toBe(true);
    expect(last.payload).toMatchObject({ proposalId: designProposalId(runId), text: long });
  });

  it("a tool refused on the last call ends the run as a finish in words would — the model's words, the proposal promoted — never a stop", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const refused = turn([use("propose_workout", { doc: { title: "Broken" }, target: { kind: "new", date: TODAY } })], "Calm hips is ready for you.");
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), refused]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect(await runRow(runId)).toMatchObject({ status: "finished", error: null, proposalId: designProposalId(runId) });
    expect((await proposalOf(runId))!.status).toBe("pending");
    const lines = (await trail(runId)).map((e) => e.summary);
    expect(lines).not.toContain(LINES.stepCap);
    expect(lines.at(-1)).toBe("Calm hips is ready for you.");
  });

  it("a refused finish's own words are the line when it carried them", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const refused = turn([use("finish", { summary: "Calm hips is waiting for you.", extra: true })], "");
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), refused]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect((await trail(runId)).at(-1)!.summary).toBe("Calm hips is waiting for you.");
    expect((await proposalOf(runId))!.status).toBe("pending");
  });
});
