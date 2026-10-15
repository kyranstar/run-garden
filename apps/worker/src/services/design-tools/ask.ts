/**
 * ask_athlete(questions) — one or two questions whose answers would change the design (Stage 3 spec §7; principles
 * §5.3, §6.10). Each has tappable chips; the athlete can always answer in their own words (`allowFreeText` is always
 * true) or skip. Its control is `ask`: the loop pauses the run (`waiting_athlete`) and writes the question event whose
 * payload is this answer's `data` — exactly what the run view shows: each question's text, why, its chips' labels, and
 * the check-in it declares — and the athlete's answer, marked as theirs, becomes this call's result when they give it
 * (`POST /api/coach/runs/:id/answer`).
 *
 * A CHECK-IN QUESTION (ruling 3): a question may declare a check-in it asks (`checkin: { question, area? }` — soreness,
 * tightness and pain by area, energy alone), and each chip what it records (`{ label, value?, area? }`). Its answer is
 * then kept as the athlete's answer (record-answer.ts `askedAnswerRows`, `source 'ask_athlete'`): a tapped chip's value
 * and area, or the words typed. A question that declares none ("how long do you have?") is answered in the run only.
 * The areas are checked here, so an answer can be kept as it is given: one statement, the athlete's focus areas, read
 * only when an area is none of the library's.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { athleteProfiles } from "@rg/database";
import type { DesignTool } from "./types.js";
import { isErr, parseAct } from "./act-common.js";
import { refuse } from "./read-common.js";
import { AREA_FIX, CHECKIN_IDS, CHECKIN_QUESTIONS, focusAreasOf, libraryArea, subjectOf } from "./record-answer.js";

export const MAX_QUESTIONS = 2;
export const MAX_CHIPS = 6;
const TEXT_MAX = 200;
const CHIP_MAX = 40;
const WHY_MAX = 200;

const line = (max: number) => z.string().trim().min(1).max(max);
const chip = z.union([line(CHIP_MAX), z.object({ label: line(CHIP_MAX), value: z.number().int().min(0).max(10).optional(), area: z.string().min(1).max(80).optional() }).strict()]);
const question = z
  .object({
    text: line(TEXT_MAX),
    chips: z.array(chip).min(1).max(MAX_CHIPS, `at most ${MAX_CHIPS} chips a question`),
    allowFreeText: z.literal(true).optional(),
    why: line(WHY_MAX),
    checkin: z.object({ question: z.enum(CHECKIN_IDS), area: z.string().min(1).max(80).optional() }).strict().optional(),
  })
  .strict();
const input = z.object({ questions: z.array(question).min(1).max(MAX_QUESTIONS, `at most ${MAX_QUESTIONS} questions at a time`) }).strict();

const labelOf = (c: z.infer<typeof chip>): string => (typeof c === "string" ? c : c.label);

export const askAthlete: DesignTool = {
  name: "ask_athlete",
  description:
    "Ask one or two questions whose answers would change the design — never what a tool can read. Each has 1–6 tappable chips; the athlete may answer in their own words or skip. A check-in question (soreness, tightness, pain, energy) keeps its answer. The run waits.",
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
            chips: {
              type: "array",
              minItems: 1,
              maxItems: MAX_CHIPS,
              items: {
                anyOf: [
                  { type: "string", minLength: 1, maxLength: CHIP_MAX },
                  {
                    type: "object",
                    description: "For a check-in question: what tapping it records.",
                    properties: {
                      label: { type: "string", minLength: 1, maxLength: CHIP_MAX },
                      value: { type: "integer", minimum: 0, maximum: 10 },
                      area: { type: "string", description: "Its own area, when the chips name different ones." },
                    },
                    required: ["label"],
                    additionalProperties: false,
                  },
                ],
              },
            },
            allowFreeText: { const: true, description: "Always true: the athlete can answer in their own words." },
            why: { type: "string", minLength: 1, maxLength: WHY_MAX, description: "How the answer changes the design." },
            checkin: {
              type: "object",
              description: "The check-in this question asks, so its answer is kept: soreness, tightness or pain by area (a region, muscle or focus-area id), energy alone.",
              properties: { question: { type: "string", enum: [...CHECKIN_IDS] }, area: { type: "string" } },
              required: ["question"],
              additionalProperties: false,
            },
          },
          required: ["text", "chips", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  statementCost: 1,
  roles: ["main", "designer"],
  control: "ask",
  async run(ctx, raw) {
    const p = parseAct(input, raw, `questions: 1–${MAX_QUESTIONS}, each { text, chips (1–${MAX_CHIPS}), why, checkin? }`);
    if (isErr(p)) return p;
    const areas: string[] = [];
    for (const [i, q] of p.questions.entries()) {
      const seen = new Set<string>();
      for (const c of q.chips) {
        const key = labelOf(c).toLowerCase();
        if (seen.has(key)) return refuse("invalid_input", `questions.${i}.chips: "${labelOf(c)}" is there twice.`, "Give each chip once.");
        seen.add(key);
        if (typeof c !== "string" && !q.checkin && (c.value !== undefined || c.area !== undefined)) {
          return refuse("invalid_input", `questions.${i}.chips: "${c.label}" records a value or area, but the question declares no checkin.`, "Declare checkin, or give the chips as plain labels.");
        }
      }
      if (!q.checkin) continue;
      const byArea = CHECKIN_QUESTIONS[q.checkin.question].byArea;
      const chipAreas = q.chips.flatMap((c) => (typeof c !== "string" && c.area ? [c.area] : []));
      if (!byArea && (q.checkin.area || chipAreas.length > 0)) {
        return refuse("bad_area", `questions.${i}: ${q.checkin.question} is not asked by area.`, "Leave the areas out for energy.");
      }
      if (byArea && !q.checkin.area && q.chips.some((c) => typeof c === "string" || !c.area)) {
        return refuse("bad_area", `questions.${i}: ${q.checkin.question} is kept by area: name the area the question asks about.`, AREA_FIX);
      }
      areas.push(...(q.checkin.area ? [q.checkin.area] : []), ...chipAreas);
    }
    // The areas the library doesn't hold must be the athlete's focus areas: one read, only then.
    const unknown = areas.filter((a) => !libraryArea(a));
    if (unknown.length > 0) {
      const [row] = (await ctx.db.all(
        sql`select (select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${ctx.userId}) as focus`,
      )) as Array<{ focus: unknown }>;
      const focus = focusAreasOf(row?.focus);
      const bad = unknown.find((a) => !subjectOf(a, focus));
      if (bad) return refuse("bad_area", `"${bad}" is no region, muscle or focus area.`, AREA_FIX);
    }
    const questions = p.questions.map((q) => ({
      text: q.text,
      chips: q.chips.map(labelOf),
      allowFreeText: true as const,
      why: q.why,
      ...(q.checkin ? { checkin: q.checkin } : {}),
    }));
    return { data: { questions }, summary: questions.map((q) => q.text).join(" · ") };
  },
};
