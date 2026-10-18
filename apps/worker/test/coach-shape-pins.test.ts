/**
 * THE NEW SHAPE'S PINS ON THE COACH (stream A, part 6). The conversation, the auto scope, answers, `replaces` and the
 * plan powers added text the model reads on every call — the shared prompt, the main coach's block, the tools — so:
 *  - every word of it stays generic (a public repository: no condition the library's profiles know, nothing personal);
 *  - the cached prefix a main run sends (the tools, the shared prompt, the main coach's block) grew by about 1.5k tokens
 *    at most against the wave's start (2c3d019), measured at the loop's own 3.5 bytes a token — REBASED 2026-10-18 for
 *    §8's two prompt streams (R's designed runs, W's whole plans): against §8's start (5908769), about 1.5k tokens each,
 *    3k together;
 *  - the opening message's per-run parts (the conversation so far, the auto scope's line) stay what their own tests pin
 *    (coach-conversation.test.ts, coach-auto.test.ts).
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { PROMPT_BYTES_PER_TOKEN, RUN_LIMITS } from "../src/services/coach-runs.js";
import { roleBlock, SHARED_PROMPT } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";

/** The cached prefix of a main run at §8's start (5908769; the new shape's own start, 2c3d019, was 33,512 + 20,323 +
 * 3,864), in characters: the tools as sent, the shared prompt, the main coach's block with its turns. */
const BEFORE = { tools: 34_935, shared: 20_450, main: 4_586 };
/** §8's two prompt streams (R's designed runs, W's whole plans): about 1.5k tokens each, at the loop's bytes a token. */
const GROWTH_MAX_CHARS = 2 * Math.round(1_500 * PROMPT_BYTES_PER_TOKEN);

const toolsSent = () => JSON.stringify(allTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })));

/** Every word a condition profile owns: its id and label, its check, flag and care words, its rating attributes. */
function profileWords(): string[] {
  return Object.values(PROFILES).flatMap((p) => [
    p.id,
    p.label,
    p.check.label,
    ...(p.setFlag ? [p.setFlag.id, p.setFlag.label, p.setFlag.pastTense] : []),
    ...(p.care ? [p.care.block.label, ...p.care.block.roles] : []),
    ...Object.keys(p.attributes),
    p.quietPhrase,
    ...(p.calmStreakLabel ? [p.calmStreakLabel] : []),
  ]);
}

describe("the coach's cached prefix after the new shape", () => {
  it(`grew by about 1.5k tokens a stream at most (${GROWTH_MAX_CHARS} characters for §8's two)`, () => {
    const now = { tools: toolsSent().length, shared: SHARED_PROMPT.length, main: roleBlock("main", RUN_LIMITS.main.maxCalls).length };
    const grown = now.tools + now.shared + now.main - (BEFORE.tools + BEFORE.shared + BEFORE.main);
    expect(grown).toBeGreaterThan(0);
    expect(grown, JSON.stringify(now)).toBeLessThanOrEqual(GROWTH_MAX_CHARS);
  });

  it("every word the coach writes for the model stays generic: no condition profile's words in the prompt, a tool's description or a field's", () => {
    // (A schema's enums are the library's own vocabulary — a role such as a care block's — generated, never written here.)
    const descriptions = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.flatMap(descriptions)
        : v && typeof v === "object"
          ? Object.entries(v).flatMap(([k, x]) => (k === "description" && typeof x === "string" ? [x] : descriptions(x)))
          : [];
    const tools = allTools().flatMap((t) => [t.description, ...descriptions(t.inputSchema)]);
    const text = [SHARED_PROMPT, roleBlock("main", 12), roleBlock("designer", 10), roleBlock("reviewer", 3), ...tools].join("\n").toLowerCase();
    for (const w of profileWords()) expect(text, w).not.toContain(w.toLowerCase());
  });
});
