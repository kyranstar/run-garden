/**
 * The card's lines and why reach the coach's next turn (import trail phase 3, Task 9; design 2026-11-05 §3.3, §6.4): a
 * later turn's conversation block carries each pins line — in or out, the move, where, the dose, the coach's words and
 * its cites — the card's why, and each correction, so "why did you leave X out?" reaches a coach that has its own
 * reason; read_proposals and the suggestion's read carry them too. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { designedManifest } from "../src/routes/design-proposals.js";
import { cardsOf, CONVERSATION_BLOCK_MAX_CHARS, conversationBlock, conversationRows, namedConversationSql } from "../src/services/coach-conversation.js";
import { markUntrusted } from "../src/services/design-prompt.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { readProposals } from "../src/services/design-tools/read-proposals.js";
import { isToolErr } from "../src/services/design-tools/types.js";
import { pinsId } from "../src/services/proposal-kinds.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { coachProposals, coachRuns } = schema;
const NOW = new Date("2026-10-21T08:00:00.000Z");
const ENV = {} as Env;
const WHY = "The lift fills the hip work your plan lacks; the nod repeats your care.";

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db, { timezone: "UTC" }));
});

const cite = (id: string) => (id === "history" ? { id, kind: "history", label: "your history" } : { id, kind: "quote", label: "said 1:12", postId: "post-1", position: 0, quote: 0 });
const LIFT_LINE = {
  moveId: "myZorbexHipLiftAbc123", name: "Zorbex hip lift", text: "She says it's for stiff hips after easy runs.", decision: "in", where: "joins your mobility rotation", dose: "6–10 reps",
  cites: [cite("q1.1"), cite("history")], post: { id: "post-1", position: 0 },
};
const NOD_LINE = { moveId: "myZorbexNeckNodAbc123", name: "Zorbex neck nod", text: "Your neck care already covers it.", decision: "out", cites: [cite("history")] };
const FIX = {
  kind: "import_correction", id: "fix-move-myZorbexHipLiftAbc123-dose", target: "move", targetId: "myZorbexHipLiftAbc123", field: "dose",
  before: { type: "reps", range: [6, 10] }, after: { type: "time", range: [30, 30], sets: [2, 2] }, why: "The transcript says two sets of thirty seconds.", basis: "evidence",
  cites: [cite("q1.1")], name: "Zorbex hip lift", line: "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)", posts: ["post-1"], moveId: "myZorbexHipLiftAbc123",
  date: "2026-10-21", toolUseId: "toolu_fix", at: NOW.toISOString(),
};

/** A finished main run whose proposal holds `ops`. */
async function turn(ops: unknown[], status = "pending"): Promise<string> {
  const runId = `run-${newId()}`;
  await db.insert(coachRuns).values({
    id: runId, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: "Fit the new moves from my saves.", status: "finished", state: null, steps: 3, costUsd: 0,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  });
  await db.insert(coachProposals).values({
    id: designProposalId(runId), userId, title: "Two saved moves", evidence: "", rationale: WHY, flags: [], ops, status, createdAt: NOW.toISOString(), expiresAt: "2026-10-24",
  } as never);
  return runId;
}
const pins = (runId: string, lines: unknown[]) => ({
  kind: "move_pins", id: pinsId(runId), pin: ["myZorbexHipLiftAbc123"], unpin: [], batchId: "batch-1", why: WHY, title: "Two saved moves",
  summary: "One joins the rotation.", lines, date: "2026-10-21", toolUseId: "toolu_pins", at: NOW.toISOString(),
});

async function blockFor(runId: string): Promise<string> {
  const rows = await conversationRows(db, userId, namedConversationSql(userId, runId), { limit: 6 });
  return conversationBlock(rows, NOW)!;
}

describe("the card's lines and why in the next turn", () => {
  it("each line — in or out, the move, where, the dose, the coach's words, its cites — then the why, then the corrections", async () => {
    const block = await blockFor(await turn([pins("run-a", [LIFT_LINE, NOD_LINE]), FIX]));
    // The card's batch, and each line's move and post (audit fixes, E1): a later turn reads the move's evidence by them.
    expect(block).toMatch(/Suggested moves for the engine's pool \(id dp-run-[^,]+, batch batch-1\): /);
    expect(block).toContain(`    - in ${markUntrusted("saved post", "Zorbex hip lift")} (move myZorbexHipLiftAbc123, post post-1:0): ${markUntrusted("main coach", "joins your mobility rotation · 6–10 reps · She says it's for stiff hips after easy runs.")} [q1.1, history]`);
    expect(block).toContain(`    - out ${markUntrusted("saved post", "Zorbex neck nod")} (move myZorbexNeckNodAbc123): ${markUntrusted("main coach", "Your neck care already covers it.")} [history]`);
    expect(block).toContain(`    Why: ${markUntrusted("main coach", WHY)}`);
    expect(block).toContain(`    - Correction: ${markUntrusted("main coach", "Dose of Zorbex hip lift: 30 s, 2 sets (was 6–10 reps)")} — still open`);
  });

  it("thirty long lines stay within the block's bound, every move named", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ ...NOD_LINE, moveId: `myZorbexMove${String(i).padStart(2, "0")}Abc123`, name: `Zorbex move ${i}`, text: "Left in your library: ".concat("slow and even through the whole range ".repeat(7)) }));
    const runId = await turn([]);
    await db.update(coachProposals).set({ ops: [pins(runId, lines)] }).where(schemaEq(designProposalId(runId)));
    const block = await blockFor(runId);
    expect(block.length).toBeLessThanOrEqual(CONVERSATION_BLOCK_MAX_CHARS);
    for (let i = 0; i < 30; i++) expect(block).toContain(`${markUntrusted("saved post", `Zorbex move ${i}`)} (move myZorbexMove${String(i).padStart(2, "0")}Abc123`);
  });

  it("an old card reads as before: plain lines, no decision, no cites", async () => {
    const runId = await turn([]);
    await db.update(coachProposals).set({ ops: [pins(runId, ["Zorbex hip lift — in rotation.", { moveId: "myZorbexNeckNodAbc123", name: "Zorbex neck nod", text: "Waits." }])] }).where(schemaEq(designProposalId(runId)));
    const block = await blockFor(runId);
    expect(block).toContain(`    - ${markUntrusted("main coach", "Zorbex hip lift — in rotation.")}`);
    expect(block).toContain(`    - ${markUntrusted("saved post", "Zorbex neck nod")} (move myZorbexNeckNodAbc123): ${markUntrusted("main coach", "Waits.")}`);
  });

  it("a suggestion of corrections alone is a card of its own; beside a pins card they ride it", async () => {
    const alone = cardsOf(null, { id: "dp-x", title: "Fix", status: "pending", ops: [{ kind: "import_correction", opId: "fix-1", fixLine: FIX.line } as never] }, "2026-10-21");
    expect(alone).toEqual([{ kind: "corrections", proposalId: "dp-x", status: "pending", title: "A correction to your saves", summary: "1 correction", lines: [FIX.line] }]);
    const beside = cardsOf(null, { id: "dp-x", title: "Fix", status: "pending", ops: [{ kind: "move_pins", opId: "pins-1", planTitle: "In", planSummary: "s", lines: [] } as never, { kind: "import_correction", opId: "fix-1", fixLine: FIX.line } as never] }, "2026-10-21");
    expect(beside.map((c) => c.kind)).toEqual(["pins"]);
  });

  it("read_proposals: a card's lines in brief and its corrections, marked", async () => {
    const runId = await turn([]);
    await db.update(coachProposals).set({ ops: [pins(runId, [LIFT_LINE, NOD_LINE]), FIX] }).where(schemaEq(designProposalId(runId)));
    const r = await readProposals.run({ db, env: ENV, userId, run: { id: "r", role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW }, {});
    if (isToolErr(r)) throw new Error(r.why);
    const ops = (r.data as { proposals: Array<{ ops: Array<Record<string, unknown>> }> }).proposals[0]!.ops;
    const card = ops.find((o) => o.kind === "move_pins")!;
    // The card's batch, and each line's move and post (audit fixes, E1).
    expect(card.batchId).toBe("batch-1");
    expect(card.lines).toEqual([
      { untrusted: true, text: "in Zorbex hip lift (move myZorbexHipLiftAbc123, post post-1:0): joins your mobility rotation · 6–10 reps · She says it's for stiff hips after easy runs. [q1.1, history]" },
      { untrusted: true, text: "out Zorbex neck nod (move myZorbexNeckNodAbc123): Your neck care already covers it. [history]" },
    ]);
    expect(ops.find((o) => o.kind === "import_correction")).toMatchObject({ line: { untrusted: true, text: FIX.line }, why: { untrusted: true, text: FIX.why } });
  });

  it("the suggestion's read: its corrections, each with its line, why, basis, cites and how it stands", async () => {
    const runId = await turn([]);
    const manifest = (await designedManifest(db, userId, designProposalId(runId), [pins(runId, [LIFT_LINE]), FIX], NOW)) as { corrections?: unknown[] };
    expect(manifest.corrections).toEqual([
      { opId: FIX.id, target: "move", targetId: FIX.targetId, field: "dose", name: "Zorbex hip lift", line: FIX.line, why: FIX.why, basis: "evidence", cites: FIX.cites, outcome: null },
    ]);
  });
});

const schemaEq = (id: string) => eq(coachProposals.id, id);
