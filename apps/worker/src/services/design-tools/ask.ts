/**
 * ask_athlete(questions) — one or two questions whose answers would change the design (Stage 3 spec §7; principles
 * §5.3, §6.10). Each has tappable chips; the athlete can always answer in their own words (`allowFreeText` is always
 * true) or skip. Its control is `ask`: the loop pauses the run (`waiting_athlete`) and writes the question event whose
 * payload is this answer's `data` — exactly what the run view shows — and the athlete's answer, marked as theirs,
 * becomes this call's result when they give it (`POST /api/coach/runs/:id/answer`). No statement of its own.
 */
import { z } from "zod";
import type { DesignTool } from "./types.js";
import { isErr, parseAct } from "./act-common.js";
import { refuse } from "./read-common.js";

export const MAX_QUESTIONS = 2;
export const MAX_CHIPS = 6;
const TEXT_MAX = 200;
const CHIP_MAX = 40;
const WHY_MAX = 200;

const line = (max: number) => z.string().trim().min(1).max(max);
const question = z
  .object({
    text: line(TEXT_MAX),
    chips: z.array(line(CHIP_MAX)).min(1).max(MAX_CHIPS, `at most ${MAX_CHIPS} chips a question`),
    allowFreeText: z.literal(true).optional(),
    why: line(WHY_MAX),
  })
  .strict();
const input = z.object({ questions: z.array(question).min(1).max(MAX_QUESTIONS, `at most ${MAX_QUESTIONS} questions at a time`) }).strict();

export const askAthlete: DesignTool = {
  name: "ask_athlete",
  description:
    "Ask one or two questions whose answers would change the design — never what a tool can read. Each has 1–6 tappable chips; the athlete may answer in their own words or skip. The run waits for the answer.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: TEXT_MAX },
            chips: { type: "array", minItems: 1, maxItems: MAX_CHIPS, items: { type: "string", minLength: 1, maxLength: CHIP_MAX } },
            allowFreeText: { const: true, description: "Always true: the athlete can answer in their own words." },
            why: { type: "string", minLength: 1, maxLength: WHY_MAX, description: "How the answer changes the design." },
          },
          required: ["text", "chips", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  statementCost: 0,
  roles: ["main", "designer"],
  control: "ask",
  async run(_ctx, raw) {
    const p = parseAct(input, raw, `questions: 1–${MAX_QUESTIONS}, each { text, chips (1–${MAX_CHIPS}), why }`);
    if (isErr(p)) return p;
    for (const [i, q] of p.questions.entries()) {
      const seen = new Set<string>();
      for (const chip of q.chips) {
        const key = chip.toLowerCase();
        if (seen.has(key)) return refuse("invalid_input", `questions.${i}.chips: "${chip}" is there twice.`, "Give each chip once.");
        seen.add(key);
      }
    }
    const questions = p.questions.map((q) => ({ text: q.text, chips: q.chips, allowFreeText: true as const, why: q.why }));
    return { data: { questions }, summary: questions.map((q) => q.text).join(" · ") };
  },
};
