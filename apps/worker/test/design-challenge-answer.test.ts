/**
 * A challenge's answer is never cut (audit fixes, 2026-11-06, E2; the owner's rule: never truncate a reasonable model
 * call). The main coach answers a challenge with its call first — then the athlete's point, fairly, then the evidence —
 * so a cut can't lose the call; and a finish that answers the athlete's own words, even beside a suggestion, keeps up to
 * ANSWER_MAX, as the conversation block keeps the newest turn's coach line for the next turn (which must see what it
 * held to tell the athlete insisting). Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { conversationBlock, conversationRows, namedConversationSql } from "../src/services/coach-conversation.js";
import { roleBlock } from "../src/services/design-prompt.js";
import { ANSWER_MAX, LINE_MAX } from "../src/services/design-tools/finish.js";
import { ACT_TOOLS } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { isToolErr, type ToolContext } from "../src/services/design-tools/types.js";
import { pinsId } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { coachProposals, coachRuns, coachRunEvents } = schema;
const NOW = new Date("2026-10-28T08:00:00.000Z");
const ENV = { COACH_DESIGNER: "1" } as unknown as Env;

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

/** Six sentences, about 600 characters: an answer to a challenge in its order. */
const ANSWER = [
  "I'm holding the hip lift in, at two sets of thirty seconds.",
  "You're right that your hips felt fine on Tuesday's run, and one good day counts for something.",
  "But the creator says it is for hips that stiffen after easy runs, at 3:12 in the video, and your last three easy runs logged a stiff-hip flag.",
  "Your mobility goal has had no hip work for three weeks.",
  "So it stays, after Thursday's easy run, where it costs nothing.",
  "If you still want it out, say so and I'll take it out.",
].join(" ");

const pinsOp = (runId: string) => ({
  kind: "move_pins", id: pinsId(runId), pin: ["myZorbexHipLiftAbc123"], unpin: [], batchId: "batch-1", why: "w", title: "Hip lift", summary: "s",
  lines: [], date: "2026-10-28", toolUseId: "toolu_p", at: NOW.toISOString(),
});

/** A main run — answering the athlete's words, or a quick tap with none — whose proposal holds a pins card. */
async function runWithCard(request: string | null): Promise<ToolContext> {
  const id = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request, status: "active", state: null, steps: 0, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  await db.insert(coachProposals).values({
    id: designProposalId(id), userId, title: "Hip lift", evidence: "", rationale: "", flags: [], ops: [pinsOp(id)], status: "unreviewed", createdAt: NOW.toISOString(), expiresAt: "2026-10-31",
  } as never);
  return { db, env: ENV, userId, run: { id, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: NOW, toolUseId: `toolu_${newId()}` };
}

const finish = () => ACT_TOOLS.find((t) => t.name === "finish")!;

describe("a challenge's answer", () => {
  it("the main block puts the call first: the call, then their point fairly, then the evidence", () => {
    const main = roleBlock("main");
    const challenge = main.split("\n").find((l) => l.startsWith("- When the athlete challenges a call"))!;
    const call = challenge.indexOf("your call now, first");
    const point = challenge.indexOf("their point, stated fairly");
    const evidence = challenge.indexOf("the evidence —");
    expect(call).toBeGreaterThan(0);
    expect(point).toBeGreaterThan(call);
    expect(evidence).toBeGreaterThan(point);
    // A past card's evidence is one read away (E1); the answer is finished as a challenge's, whole.
    expect(challenge).toContain("read_saves with the move's id");
    expect(challenge).toContain("finish with challenge: true");
  });

  it("a finish answering the athlete's challenge (challenge: true) keeps the whole answer beside its suggestion, up to ANSWER_MAX", async () => {
    expect(ANSWER.length).toBeGreaterThan(LINE_MAX);
    expect(ANSWER.length).toBeLessThan(ANSWER_MAX);
    const ctx = await runWithCard("Take the hip lift out — my hips are fine.");
    const r = await finish().run(ctx, { summary: ANSWER, challenge: true });
    if (isToolErr(r)) throw new Error(r.why);
    expect(r.summary).toBe(ANSWER);
    expect((r.data as { proposalId?: string }).proposalId).toBe(designProposalId(ctx.run.id));
    expect(r.receipt).toMatchObject({ final: true, challenge: true });
    // The schema says when.
    const summary = (finish().inputSchema.properties as Record<string, { description: string }>).challenge!.description;
    expect(summary).toMatch(/challenge/i);
  });

  it("an ordinary suggestion's line, and a 'challenge' with no words of the athlete's (a quick tap), still clip at LINE_MAX, at a sentence", async () => {
    for (const [request, input] of [["Something for my hips.", { summary: ANSWER }], [null, { summary: ANSWER, challenge: true }]] as const) {
      const ctx = await runWithCard(request);
      const r = await finish().run(ctx, input);
      if (isToolErr(r)) throw new Error(r.why);
      expect(r.summary!.length).toBeLessThanOrEqual(LINE_MAX);
      expect(r.summary!.endsWith(".")).toBe(true);
      expect(r.receipt).not.toHaveProperty("challenge");
    }
  });

  it("the conversation block carries the newest turn's coach line up to ANSWER_MAX; an older turn's at LINE_MAX", async () => {
    const conv = `run-${newId()}`;
    const turn = async (id: string, at: string, line: string) => {
      await db.insert(coachRuns).values({
        id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Why the hip lift?", status: "finished",
        state: JSON.stringify({ settings: { conversationId: conv } }), steps: 1, costUsd: 0, createdAt: at, updatedAt: at,
      } as never);
      await db.insert(coachRunEvents).values({ id: `${id}:1`, userId, runId: id, seq: 1, kind: "note", summary: line, payload: { text: line, final: true }, at } as never);
    };
    await turn(conv, "2026-10-28T07:00:00.000Z", `Older: ${ANSWER}`);
    await turn(`run-${newId()}`, "2026-10-28T07:30:00.000Z", ANSWER);
    const rows = await conversationRows(db, userId, namedConversationSql(userId, conv), { limit: 6 });
    const block = conversationBlock(rows, NOW)!;
    // The newest: whole.
    expect(block).toContain(ANSWER);
    // The older: clipped at a sentence within LINE_MAX.
    const older = block.split("\n").find((l) => l.includes("Older: "))!;
    expect(older).not.toContain("If you still want it out");
  });
});

describe("figures from where the athlete stands (audit fixes, E5)", () => {
  it("the honesty rule takes a figure from the opening message's computed blocks as it does a tool result's", async () => {
    const { SHARED_PROMPT } = await import("../src/services/design-prompt.js");
    expect(SHARED_PROMPT).toContain(
      'A figure inside a reason ("untrained for 6 days") must come from a tool result you read or the opening message\'s computed blocks (where the athlete stands, the index), never an estimate.',
    );
  });

  it("the reviewer's packet carries the where-you-stand block handed in, after a line saying whose figures they are", async () => {
    const { reviewPacket, STAND_LEAD } = await import("../src/services/design-review.js");
    const { STAND_HEADING } = await import("../src/services/where-you-stand.js");
    const stand = `${STAND_HEADING}\n- Zorbex hold: 45 s of 90 s by 1 Dec — behind\nNeeds you: nothing the app sees.`;
    const draft = { proposalId: "dp-x", target: { kind: "new" as const, date: "2026-10-29" }, date: "2026-10-29", doc: (await import("./doc-workout-fixture.js")).calmDoc(), issues: [], derived: {} };
    const packet = reviewPacket({ round: 1, draft, records: [], stand });
    expect(packet).toContain(`${STAND_LEAD}\n${stand}`);
    expect(packet.indexOf(STAND_LEAD)).toBeLessThan(packet.indexOf("# The designer's tool results"));
  });
});
