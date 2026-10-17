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
 * then kept as the athlete's answer (record-answer.ts `askedAnswerRows`, `source 'ask_athlete'`): the chip tapped, its
 * value and area — words typed instead of a chip stay the run's answer only. A question that declares none ("how long
 * do you have?") is answered in the run only.
 * The areas are checked here, so an answer can be kept as it is given: one statement, the athlete's focus areas, read
 * only when an area is none of the library's.
 *
 * TODAY'S CONDITION CHECK (fix wave 3A, A8): `{ check: "condition", why }` in place of questions — no wording of the
 * model's: the app shows its own condition check, the athlete logs it, and the answer (`POST …/answer` with the check's
 * id, saved today, after the question) resumes the run with a result saying it was logged: validate again, and the
 * gates that read it open. No statement.
 *
 * A SET'S DESIGNER CAN'T ASK (fix wave 3A, A9): the main coach asks what the set needs before plan_set, so a set's
 * designers never stop it behind a question; the refusal teaches the designer to decide and say what it assumed.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { athleteProfiles } from "@rg/database";
import type { DesignTool } from "./types.js";
import { capInWords, isErr, parseAct, prose } from "./act-common.js";
import { athleteText, clipProse } from "../design-prose.js";
import { refuse } from "./read-common.js";
import { AREA_FIX, CHECKIN_IDS, CHECKIN_QUESTIONS, focusAreasOf, libraryArea, subjectOf } from "./record-answer.js";

export const MAX_QUESTIONS = 2;
export const MAX_CHIPS = 6;
const TEXT_MAX = 200;
const CHIP_MAX = 40;
const WHY_MAX = 200;

/** A question's words and its chips are held to their caps — a question is never cut — and a refusal says the length in
 * words; its `why` is free text (Task 13's fix wave, §2.1): kept up to four times its cap, clipped where the athlete reads
 * it. */
const line = (max: number) => prose(max, 1);
const chip = z.union([line(CHIP_MAX), z.object({ label: line(CHIP_MAX), value: z.number().int().min(0).max(10).optional(), area: z.string().min(1).max(80).optional() }).strict()]);
const question = z
  .object({
    text: line(TEXT_MAX),
    chips: z.array(chip).min(1).max(MAX_CHIPS, `at most ${MAX_CHIPS} chips a question`),
    allowFreeText: z.literal(true).optional(),
    why: prose(WHY_MAX),
    checkin: z.object({ question: z.enum(CHECKIN_IDS), area: z.string().min(1).max(80).optional() }).strict().optional(),
  })
  .strict();
const input = z.object({ questions: z.array(question).min(1).max(MAX_QUESTIONS, `at most ${MAX_QUESTIONS} questions at a time`) }).strict();
/** Today's condition check asked for (fix wave 3A, A8): no wording of the model's — the app shows its own check. */
const checkInput = z.object({ check: z.literal("condition"), why: prose(WHY_MAX) }).strict();

const labelOf = (c: z.infer<typeof chip>): string => (typeof c === "string" ? c : c.label);

/** A set's designer can't ask (fix wave 3A, A9): the main coach asks what the set needs, before plan_set. */
export const SET_DESIGNER_ASKS: { why: string; fix: string } = {
  why: "In a set the main coach asks.",
  fix: "Design on your best judgement and say what you assumed in the document's notes.",
};

/** The question's line when the coach asks for today's condition check. */
export const CHECK_ASKED = "The coach asks you to log today's condition check.";

export const askAthlete: DesignTool = {
  name: "ask_athlete",
  description:
    "The main coach's, or a designer's outside a set — never a set's designer (its main coach asks, before plan_set). { questions }: one or two whose answers change the design, each with 1–6 chips; the athlete may answer in words or skip; a check-in question keeps the chip tapped. Or { check: \"condition\", why }: the athlete logs the check in the app, then you validate again. The run waits.",
  inputSchema: {
    type: "object",
    description: "Either { questions } or { check: \"condition\", why }.",
    properties: {
      check: { type: "string", enum: ["condition"], description: "Ask the athlete to log today's condition check in the app, instead of questions." },
      why: { type: "string", minLength: 1, description: `With check: why the design needs today's check — ${capInWords(WHY_MAX)}.` },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: TEXT_MAX, description: `The question: ${capInWords(TEXT_MAX)}.` },
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
            why: { type: "string", minLength: 1, description: `How the answer changes the design, to the athlete: ${capInWords(WHY_MAX)}.` },
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
    additionalProperties: false,
  },
  statementCost: 1,
  cpuWeight: 0.1,
  roles: ["main", "designer"],
  control: "ask",
  async run(ctx, raw) {
    // A set's scope (design-orchestrate.ts `isSetScope`, not imported: the registry would import it in a cycle).
    const inSet = ctx.run.scope.kind === "week" || ctx.run.scope.kind === "next_n";
    if (ctx.run.role === "designer" && ctx.run.parentId !== null && inSet) {
      return refuse("set_designer_cannot_ask", SET_DESIGNER_ASKS.why, SET_DESIGNER_ASKS.fix);
    }
    if (raw && typeof raw === "object" && "check" in raw) {
      const c = parseAct(checkInput, raw, `{ check: "condition", why } — why the design needs today's check, ${capInWords(WHY_MAX)}`);
      if (isErr(c)) return c;
      return { data: { check: c.check, why: clipProse(athleteText(c.why), WHY_MAX) }, summary: CHECK_ASKED };
    }
    const p = parseAct(input, raw, `questions: 1–${MAX_QUESTIONS}, each { text, chips (1–${MAX_CHIPS}), why, checkin? } — or { check: "condition", why }`);
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
      // What the athlete reads, in their words (round 2, I1); the chips stay as given: an answer is matched to them.
      text: athleteText(q.text),
      chips: q.chips.map(labelOf),
      allowFreeText: true as const,
      why: clipProse(athleteText(q.why), WHY_MAX),
      ...(q.checkin ? { checkin: q.checkin } : {}),
    }));
    return { data: { questions }, summary: questions.map((q) => q.text).join(" · ") };
  },
};
