/**
 * read_answers(question?, area?, since?) — what the athlete has said (Stage 3 spec §4; principles §5.3): check-in
 * answers (soreness, tightness and pain by area, energy) and feedback (ratings of moves and workouts), newest first,
 * each with its age; the athlete's own words marked. Since the last fourteen days by default; a since further back
 * than the range a read covers is refused. Two statements: the athlete (for today), then the page.
 */
import { and, asc, between, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { athleteAnswers } from "@rg/database";
import { addDays } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  ageWords,
  answer,
  checkRange,
  CURSOR_SCHEMA,
  cursorField,
  dateField,
  isErr,
  limitField,
  limitSchema,
  localTimeOf,
  offsetOf,
  parseInput,
  READ_ROLES,
  readAthlete,
  sqlPage,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_DAYS = 14;

const input = z
  .object({
    question: z.string().min(1).max(60).optional(),
    area: z.string().min(1).max(80).optional(),
    since: dateField.optional(),
    limit: limitField(MAX_LIMIT).optional(),
    cursor: cursorField.optional(),
  })
  .strict();

export const readAnswers: DesignTool = {
  name: "read_answers",
  description:
    "Check-in answers and feedback, newest first with their age: soreness, tightness and pain by area, energy, ratings of moves and workouts. Filter by question id, area or since.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "A question id: soreness, tightness, pain, energy, exercise_feedback, workout_feedback, …" },
      area: { type: "string", description: "What an answer is about: a region, muscle, focus area, exercise or workout id." },
      since: { type: "string", description: `A local date, YYYY-MM-DD. Default: ${DEFAULT_DAYS} days ago.` },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally question, area, since (YYYY-MM-DD), limit and cursor");
    if (isErr(p)) return p;
    const { athlete } = await readAthlete(ctx.db, ctx.userId, ctx.now);
    const today = athlete.today;
    const since = p.since ?? addDays(today, -(DEFAULT_DAYS - 1));
    const bad = checkRange(since, today);
    if (bad) return bad;
    const a = athleteAnswers;
    const offset = offsetOf(p.cursor);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .select({
        date: a.localDate,
        at: a.at,
        question: a.questionId,
        kind: a.subjectKind,
        subject: a.subjectId,
        value: a.valueNum,
        choice: a.valueChoice,
        text: a.text,
        source: a.source,
        expiresAt: a.expiresAt,
      })
      .from(a)
      .where(
        and(
          eq(a.userId, ctx.userId),
          between(a.localDate, since, today),
          ...(p.question ? [eq(a.questionId, p.question)] : []),
          ...(p.area ? [eq(a.subjectId, p.area)] : []),
        ),
      )
      .orderBy(desc(a.localDate), desc(a.at), asc(a.questionId), asc(a.subjectId), asc(a.id))
      .limit(limit + 1)
      .offset(offset);
    const page = sqlPage(rows, offset, limit);
    const answers = page.items.map((r) => {
      const text = untrustedOrNull(r.text);
      const expired = r.expiresAt ? r.expiresAt.slice(0, 10) < today : false;
      return {
        date: r.date,
        time: localTimeOf(athlete.tz, r.at),
        question: r.question,
        ...(r.subject ? { subject: r.kind ? `${r.kind}:${r.subject}` : r.subject } : {}),
        ...(r.value !== null ? { value: r.value } : {}),
        ...(r.choice !== null ? { choice: r.choice } : {}),
        ...(text ? { text } : {}),
        source: r.source,
        age: ageWords(r.date, today),
        ...(expired ? { expired: true } : {}),
      };
    });
    const what = `${p.question ? `${p.question} ` : ""}answers${p.area ? ` about ${p.area}` : ""}`;
    return answer({
      source: "the athlete's check-in answers and feedback",
      now: ctx.now,
      missing: answers.length === 0 && offset === 0 ? [`no ${what} since ${since}`] : [],
      data: { since, answers, nextCursor: page.nextCursor },
      summary: answers.length ? `Read ${what} since ${since}` : `Found no ${what} since ${since}`,
    });
  },
};
