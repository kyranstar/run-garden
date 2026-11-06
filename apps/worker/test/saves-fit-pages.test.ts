/**
 * A FIT-IN READS ITS WHOLE BATCH WELL INSIDE ITS CALLS (the budgets review, 2026-11-06). A typical extract-6 batch of
 * twelve new moves: the main run pages read_saves by the offsets each page gives until every move is read, then puts
 * the moves in the pool with pin_moves (which refuses a line about a move no page covered: `not_read`) and finishes —
 * in a handful of the main run's RUN_LIMITS.main.maxCalls model calls, never all of them (the 2026-11-05 "ran out of
 * steps" failure). The real registry and opening context, a scripted model that reads what each page says. No key, no
 * network. Synthetic data only: the made-up athlete of design-read-fixture.ts, on its fixed clock.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import { createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { RUN_LIMITS } from "../src/services/design-limits.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete } from "./design-read-fixture.js";
import { seedSavedBatch, typicalBatchPosts } from "./saves-batch-fixture.js";
import { makeTestDb } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_fp${++seq}`, name, input });
function turn(uses: ContentBlock[]): MessagesOk {
  return {
    ok: true,
    model: "anthropic/claude-opus-5.5",
    content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, { type: "text", text: "Reading your saves." }, ...uses],
    stopReason: uses.length > 0 ? "tool_use" : "end_turn",
    usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
    costMicros: 1_000,
  };
}

/** The last tool result the model was given, as text. */
function lastResult(req: MessagesRequest): string {
  for (const m of [...req.messages].reverse()) {
    if (typeof m.content === "string") continue;
    for (const b of [...m.content].reverse()) {
      if (b.type === "tool_result") return typeof b.content === "string" ? b.content : b.content.map((t) => t.text).join("");
    }
  }
  return "";
}

describe("a fit-in of a typical twelve-move batch (the budgets review, 2026-11-06)", () => {
  it("reads every page and closes the batch with pin_moves well inside the main run's calls", async () => {
    const db = makeTestDb();
    const { userId } = await seedRichAthlete(db);
    const savedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    const { batchId, moveIds } = await seedSavedBatch(db, userId, { savedAt, posts: typicalBatchPosts() });
    const all = moveIds.flat();
    const run = (await createRun(db, userId, { scope: { kind: "now" }, request: "Fit my saved moves in.", savesBatchId: batchId }, NOW)).run.id;

    // The model: read_saves from the start, then at each offset a page gives; once none is left, pin every move with a
    // line, then finish.
    const calls: string[] = [];
    const reads: number[] = [];
    let pinned = false;
    const deps: RunDeps = {
      callModel: async (_env, req: MessagesRequest): Promise<MessagesResult> => {
        const last = lastResult(req);
        let next: ContentBlock;
        if (calls.length === 0) next = use("read_saves", {});
        else if (!pinned && /pass offset: (\d+)/.test(last)) next = use("read_saves", { offset: Number(/pass offset: (\d+)/.exec(last)![1]) });
        else if (!pinned) {
          pinned = true;
          next = use("pin_moves", {
            pin: all,
            title: "Your saved moves",
            lines: all.map((moveId) => ({ moveId, text: "Joins your mobility rotation after easy runs.", cites: ["inferred:purpose"] })),
            why: "They suit the easy days.",
          });
        } else next = use("finish", { summary: "Twelve moves join your rotation." });
        calls.push((next as { name: string }).name);
        if ((next as { name: string }).name === "read_saves") reads.push(calls.length);
        return turn([next]);
      },
      buildContext: designContextBuilder,
      tools: allTools(),
      review: true,
      clock: () => 0,
    };
    for (let i = 0; i < RUN_LIMITS.main.maxCalls; i++) {
      const out = await runStep(db, env, run, userId, new Date(NOW.getTime() + i * 1000), deps);
      if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
      if (!["active", "stepping", "waiting_review", "waiting_set"].includes(out.result.status)) break;
    }

    // Every page read, no refusal on the way (pin_moves found each move read), and the card stored.
    const proposal = (await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(run))))[0];
    const ops = (proposal?.ops ?? []) as Array<{ kind: string; pin?: string[]; batchId?: string }>;
    const pins = ops.find((o) => o.kind === "move_pins");
    expect(pins?.batchId).toBe(batchId);
    expect(new Set(pins?.pin)).toEqual(new Set(all));
    const events = await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, run));
    const refused = events.filter((e) => e.kind === "tool_result" && JSON.stringify(e.payload).includes('"ok":false'));
    expect(refused).toEqual([]);
    // Measured 2026-11-06: four pages of three moves (REBASED for the controller's ruling — the why and two use-when cases
    // on the default page; it was three pages), then pin_moves and finish — six of the twelve calls, six left for
    // full: true reads, a question or a workout's revision.
    expect(reads.length).toBeLessThanOrEqual(4);
    expect(calls).toEqual([...reads.map(() => "read_saves"), "pin_moves", "finish"]);
    expect(calls.length).toBeLessThanOrEqual(RUN_LIMITS.main.maxCalls / 2);
  });
});
