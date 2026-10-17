/**
 * ANSWERS IN WORDS (the new shape §5; stream A, part 3). A question — "how's my wall sit going?", "why this run?" —
 * finishes with words only and no proposal. The answer's soft cap is longer than a finish line's (about 900 characters
 * against 300), clipped at its last sentence that fits (design-prose.ts `clipProse`), never refused; the trail shows it
 * whole as the coach's line (its event's summary, marked `answer`), and so does the conversation. A finish that proposes
 * keeps the 300-character line. An answer given as plain text (no finish: the nudge, then a second text turn) is an
 * answer too.
 *
 * The real registry, opening context and loop, driven by a scripted model; no key, no network. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { endedLine, createRun, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { readConversation } from "../src/services/coach-conversation.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { clipProse } from "../src/services/design-prose.js";
import { ANSWER_MAX, finish, LINE_MAX } from "../src/services/design-tools/finish.js";
import { allTools } from "../src/services/design-tools/index.js";
import type { ContentBlock, MessagesOk, MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, untilDone } from "./helpers.js";

const env = { APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1" } as Env;

let db: Db;
let userId: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await seedRichAthlete(db));
});

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_ans${++seq}`, name, input });
const turn = (uses: ContentBlock[], text = ""): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` }, ...(text ? [{ type: "text" as const, text }] : []), ...uses],
  stopReason: uses.length > 0 ? "tool_use" : "end_turn",
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});

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

async function asked(words: string, turns: MessagesResult[]) {
  const run = await createRun(db, userId, { request: words }, NOW);
  const d = deps(turns);
  let status = "";
  await untilDone(
    async (i) => {
      const out = await runStep(db, env, run.run.id, userId, new Date(NOW.getTime() + (i + 1) * 1000), d);
      if (out.kind !== "ok") throw new Error(out.kind);
      status = out.result.status;
      return status !== "active";
    },
    { max: 30, what: "drive" },
  );
  const trail = await db.select().from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, run.run.id)).orderBy(schema.coachRunEvents.seq);
  return { id: run.run.id, status, last: trail.at(-1)!, trail };
}

const sentence = (i: number) => `Your wall sits went from thirty to forty-five seconds over the third week, sitting ${i}.`;
const LONG = Array.from({ length: 14 }, (_, i) => sentence(i)).join(" ");

describe("an answer in words", () => {
  it("a finish with words only and no proposal is an answer: up to about 900 characters, clipped at a sentence, shown whole", async () => {
    expect(LONG.length).toBeGreaterThan(ANSWER_MAX);
    const { status, last } = await asked("How are my wall sits going?", [turn([use("finish", { summary: LONG })])]);
    expect(status).toBe("finished");
    const shown = clipProse(LONG, ANSWER_MAX);
    expect(shown.length).toBeGreaterThan(LINE_MAX);
    expect(shown.length).toBeLessThanOrEqual(ANSWER_MAX);
    expect(shown.endsWith(".")).toBe(true);
    expect(last.kind).toBe("note");
    expect(last.summary).toBe(shown);
    expect(last.payload).toMatchObject({ receipt: { final: true, answer: true } });
    expect((last.payload as Record<string, unknown>).text).toBeUndefined();
    const conv = await readConversation(db, userId, NOW, { endedLine });
    expect(conv.turns.at(-1)).toMatchObject({ words: "How are my wall sits going?", line: shown, cards: [] });
  });

  it("a short answer is whole, and costs no proposal", async () => {
    const { id, last } = await asked("Why this run?", [turn([use("finish", { summary: "It keeps Saturday fresh for the long run." })])]);
    expect(last.summary).toBe("It keeps Saturday fresh for the long run.");
    expect(await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, `dp-${id}`))).toEqual([]);
  });

  it("an answer given as text, nudged once, is still an answer — its words the line, up to the answer's cap", async () => {
    const { status, last, trail } = await asked("How are my wall sits going?", [turn([], LONG), turn([], LONG)]);
    expect(status).toBe("finished");
    expect(last.summary).toBe(clipProse(LONG, ANSWER_MAX));
    expect(last.payload).toMatchObject({ final: true, answer: true });
    expect(trail.filter((e) => e.kind === "note" && e.summary.startsWith("Your wall sits")).length).toBeGreaterThanOrEqual(1);
    const conv = await readConversation(db, userId, NOW, { endedLine });
    expect(conv.turns.at(-1)!.line).toBe(clipProse(LONG, ANSWER_MAX));
  });

  it("a finish that suggests something keeps the finish line's 300 characters", async () => {
    const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
    const review = { scores: Object.fromEntries(DIMS.map((d) => [d, 4])), notes: Object.fromEntries(DIMS.map((d) => [d, "Fine."])), mustFix: [], improvements: [] };
    const { last } = await asked("Something for my hips.", [
      turn([use("propose_workout", { doc: calmDoc({ title: "Hips" }), target: { kind: "new", date: TODAY } })]),
      turn([use("submit_review", review)]),
      turn([use("finish", { summary: LONG })]),
    ]);
    expect(last.summary.length).toBeLessThanOrEqual(LINE_MAX);
    expect(last.payload).toMatchObject({ receipt: { final: true } });
    expect((last.payload as { receipt: Record<string, unknown> }).receipt.answer).toBeUndefined();
  });

  it("the finish tool says the answer's cap to the model", () => {
    const summary = (finish.inputSchema.properties as Record<string, { description: string }>).summary!.description;
    expect(summary).toMatch(/an answer/i);
    expect(summary).toMatch(/900/);
  });
});
