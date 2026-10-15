/**
 * record_answer(answers) — what the athlete's request itself states, kept as check-in answers so the next design knows
 * it (Stage 3 spec §4; principles §5.3): soreness, tightness and pain by area, energy on its own — the check-ins'
 * question ids, and their areas (a library region or muscle, or one of the athlete's focus areas). Each answer quotes
 * the request's own words, and a quote the request doesn't hold is refused: this keeps what was SAID; what the coach
 * concluded goes to `remember`, marked as inferred. Rows are `athlete_answers` with `source 'request'` on the athlete's
 * local today, the quote as the athlete's words.
 *
 * Undo: every row of one call shares the call's handle (`ra:<main run>:<tool-use id>`, each row `<handle>:<n>`), which
 * the call's receipt carries to the run view; `POST /api/coach/runs/:id/undo-answer { handle }` takes them back
 * (`undoRecordedAnswers`). A replayed call writes the same ids, so nothing doubles. Two statements: the athlete (with the
 * run's request and the focus areas), then one insert.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { athleteAnswers, athleteProfiles, coachRuns } from "@rg/database";
import { MUSCLES, REGIONS } from "@rg/exercise-library";
import type { Db } from "../db.js";
import type { DesignTool } from "./types.js";
import { isErr, parseAct } from "./act-common.js";
import { parsedArray, readAthlete, refuse } from "./read-common.js";

/** The check-ins' questions a request can state (principles §5.3; Stage 4 owns the registry). */
export const REQUEST_QUESTIONS = ["soreness", "tightness", "pain", "energy"] as const;
/** The questions answered by area. */
const BY_AREA = new Set<string>(["soreness", "tightness", "pain"]);
const MAX_ANSWERS = 6;
const QUOTE_MAX = 200;

const REGION_SET = new Set<string>(REGIONS);
const MUSCLE_SET = new Set<string>(MUSCLES);

const input = z
  .object({
    answers: z
      .array(
        z
          .object({
            question: z.enum(REQUEST_QUESTIONS),
            area: z.string().min(1).max(80).optional(),
            value: z.number().int().min(0).max(10).optional(),
            quote: z.string().trim().min(1).max(QUOTE_MAX),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_ANSWERS),
  })
  .strict();

/** Words compared without case, punctuation or spacing. */
const words = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The handle an undo names; the run's own id is in it, so an undo can only reach its own run's answers. */
export const answerHandle = (mainRunId: string, toolUseId: string): string => `ra:${mainRunId}:${toolUseId}`;
const HANDLE = /^ra:([^:]{1,120}):([A-Za-z0-9_-]{1,120})$/;
/** The main run a handle belongs to, or null for a handle that isn't one. */
export const handleRunId = (handle: string): string | null => HANDLE.exec(handle)?.[1] ?? null;

type Subject = { kind: "region" | "muscle" | "focus_area"; id: string; words: string };

const areaWords = (id: string): string => id.replace(/-/g, " ");

/** "soreness — calves 8, hamstrings 3 · energy 3" */
export function answeredLine(rows: Array<{ questionId: string; subjectWords: string | null; valueNum: number | null }>): string {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const bit = [r.subjectWords, r.valueNum !== null ? String(r.valueNum) : null].filter(Boolean).join(" ");
    groups.set(r.questionId, [...(groups.get(r.questionId) ?? []), bit]);
  }
  return [...groups]
    .map(([q, bits]) => (BY_AREA.has(q) ? `${q} — ${bits.join(", ")}` : `${q}${bits.filter(Boolean).length ? ` ${bits.join(", ")}` : ""}`))
    .join(" · ");
}

export const recordAnswer: DesignTool = {
  name: "record_answer",
  description:
    "Keep what the request itself states as check-in answers, so the next design knows it: soreness, tightness or pain by area (a region, muscle or focus-area id), energy on its own, 0–10 when stated, each quoting the request's words.",
  inputSchema: {
    type: "object",
    properties: {
      answers: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ANSWERS,
        items: {
          type: "object",
          properties: {
            question: { type: "string", enum: [...REQUEST_QUESTIONS] },
            area: { type: "string", description: "soreness, tightness, pain: a region or muscle id, or one of the athlete's focus-area ids. Not for energy." },
            value: { type: "integer", minimum: 0, maximum: 10 },
            quote: { type: "string", minLength: 1, maxLength: QUOTE_MAX, description: "The request's own words that state it, copied exactly." },
          },
          required: ["question", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["answers"],
    additionalProperties: false,
  },
  statementCost: 2,
  roles: ["main"],
  async run(ctx, raw) {
    const p = parseAct(input, raw, `answers: 1–${MAX_ANSWERS}, each { question, area?, value? (0–10), quote }`);
    if (isErr(p)) return p;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      runRequest: sql`(select ${coachRuns.request} from ${coachRuns} where ${coachRuns.id} = ${ctx.run.id} and ${coachRuns.userId} = ${ctx.userId})`,
      focusAreas: sql`(select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${ctx.userId})`,
    });
    const request = typeof extra.runRequest === "string" ? extra.runRequest : "";
    const said = words(request);
    const focus = new Map(
      parsedArray(extra.focusAreas).flatMap((f) => {
        const x = f as { id?: unknown; label?: unknown };
        return typeof x.id === "string" ? [[x.id, typeof x.label === "string" ? x.label : x.id] as const] : [];
      }),
    );
    const rows: Array<typeof athleteAnswers.$inferInsert & { subjectWords: string | null }> = [];
    const handle = answerHandle(ctx.run.id, ctx.toolUseId ?? `call-${ctx.now.getTime()}`);
    for (const [i, a] of p.answers.entries()) {
      if (!said || !said.includes(words(a.quote))) {
        return refuse(
          "not_in_request",
          request ? `answers.${i}.quote "${a.quote}" is not in the athlete's request.` : "This run has no request: the athlete only tapped to start it.",
          "Quote the request's own words exactly. For what you concluded rather than read, use remember with confidence inferred.",
        );
      }
      let subject: Subject | null = null;
      if (BY_AREA.has(a.question)) {
        if (!a.area) return refuse("bad_area", `answers.${i}: ${a.question} is recorded by area.`, "Give the area: a region or muscle id, or a focus-area id from read_profile.");
        if (REGION_SET.has(a.area)) subject = { kind: "region", id: a.area, words: areaWords(a.area) };
        else if (MUSCLE_SET.has(a.area)) subject = { kind: "muscle", id: a.area, words: areaWords(a.area) };
        else if (focus.has(a.area)) subject = { kind: "focus_area", id: a.area, words: focus.get(a.area)! };
        else return refuse("bad_area", `answers.${i}.area "${a.area}" is no region, muscle or focus area.`, "Use a region or muscle id from the library, or a focus-area id from read_profile.");
      } else if (a.area) {
        return refuse("bad_area", `answers.${i}: ${a.question} is not by area.`, "Leave area out for energy.");
      }
      rows.push({
        id: `${handle}:${i}`,
        userId: ctx.userId,
        questionId: a.question,
        subjectKind: subject?.kind ?? null,
        subjectId: subject?.id ?? null,
        valueNum: a.value ?? null,
        valueChoice: null,
        text: a.quote,
        source: "request",
        localDate: athlete.today,
        at: ctx.now.toISOString(),
        subjectWords: subject?.words ?? null,
      });
    }
    // 12 bound values a row, six rows at most: one statement under D1's 100.
    await ctx.db
      .insert(athleteAnswers)
      .values(rows.map(({ subjectWords: _w, ...row }) => row))
      .onConflictDoNothing();
    const line = answeredLine(rows.map((r) => ({ questionId: r.questionId, subjectWords: r.subjectWords, valueNum: r.valueNum ?? null })));
    return {
      data: { recorded: rows.length, date: athlete.today, source: "request" },
      summary: `Noted from your request: ${line}`,
      receipt: {
        undo: { handle },
        recorded: rows.map((r) => ({ question: r.questionId, ...(r.subjectId ? { area: r.subjectId } : {}), ...(r.valueNum != null ? { value: r.valueNum } : {}) })),
      },
    };
  },
};

/**
 * Take back the answers one record_answer call kept (its `handle`), for `userId` only: deletes them and answers what
 * they were, or null when there were none (already taken back, or never this athlete's). One statement.
 */
export async function undoRecordedAnswers(db: Db, userId: string, handle: string): Promise<{ line: string; count: number } | null> {
  const a = athleteAnswers;
  const gone = await db
    .delete(a)
    .where(and(eq(a.userId, userId), eq(a.source, "request"), sql`substr(${a.id}, 1, ${handle.length + 1}) = ${`${handle}:`}`))
    .returning({ id: a.id, questionId: a.questionId, subjectKind: a.subjectKind, subjectId: a.subjectId, valueNum: a.valueNum });
  if (gone.length === 0) return null;
  gone.sort((x, y) => Number(x.id.split(":").at(-1)) - Number(y.id.split(":").at(-1)));
  const line = answeredLine(gone.map((r) => ({ questionId: r.questionId, subjectWords: r.subjectId ? areaWords(r.subjectId) : null, valueNum: r.valueNum })));
  return { line, count: gone.length };
}
