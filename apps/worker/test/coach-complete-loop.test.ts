/**
 * COMPLETE MEANS THE RUN ENDED THROUGH ITS FINISH (R1 review B-1; DESIGN-3 §3.8; the lead's v0.20 ruling): driven through
 * the real loop with a scripted model (Review B's RB-C1 and RB-C2, kept). run-garden also ends a run `finished` when it never
 * called `finish` — a words-only turn on its last call, or a tool refused on its last call — and proposes what was
 * reviewed. Such a run is complete: false (`missing.status` "unfinished"), never a phone's to approve; one that called
 * `finish` is complete. Synthetic data only.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createRun, readRunState, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { completenessOf } from "../src/services/design-version.js";
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
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_cl${++seq}`, name, input });
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

async function nowRun(userId: string, maxCalls: number): Promise<string> {
  const id = (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  const state = readRunState(row!.state)!;
  state.settings.maxCalls = maxCalls;
  await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
  return id;
}
const proposalStatus = async (runId: string) => (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId))))[0]?.status;

describe("complete means the run ended through its finish", () => {
  it("RB-C1: the run's last call's propose_workout refused (its step cap reached): finished, its reviewed draft pending — and complete: false", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const refused = turn([use("propose_workout", { doc: { title: "Broken" }, target: { kind: "new", date: TODAY } })], "Calm hips is ready for you.");
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), refused]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect(await proposalStatus(runId)).toBe("pending");
    expect(await completenessOf(db, userId, designProposalId(runId))).toEqual({ complete: false, missing: { status: "unfinished", error: null, line: expect.any(String) } });
  });

  it("RB-C2: a words-only last call (no finish, its step cap reached): finished, pending — and complete: false", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 2);
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), turn([], "I ran out of room; a second session would round the week off.")]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect(await proposalStatus(runId)).toBe("pending");
    expect((await completenessOf(db, userId, designProposalId(runId))).complete).toBe(false);
  });

  it("a run that called finish is complete", async () => {
    const { userId } = await seedRichAthlete(db);
    const runId = await nowRun(userId, 4);
    const { deps } = scripted([t(propose("Calm hips")), t(submit(verdict(4))), t(use("finish", { summary: "A calm hips session, ready to approve." }))]);
    expect((await drive(userId, runId, deps)).at(-1)!.status).toBe("finished");
    expect(await proposalStatus(runId)).toBe("pending");
    expect(await completenessOf(db, userId, designProposalId(runId))).toEqual({ complete: true });
  });
});
