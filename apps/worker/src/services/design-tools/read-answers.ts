/**
 * read_answers(question?, area?, since?) — what the athlete has said (Stage 3 spec §4; principles §5.3): check-in
 * answers (soreness, tightness and pain by area, energy) and feedback (ratings of moves and workouts), newest first,
 * each with what it is about (`subject` and `subjectKind`), its age, and the athlete's own words marked. Since the last
 * fourteen days by default; a since further back than the range a read covers is refused. A page that fits, paged by
 * key (an answer recorded meanwhile never shifts the next page). Two statements: the athlete (for today), then the page.
 */
import { and, between, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { athleteAnswers } from "@rg/database";
import { addDays, dayLabel } from "@rg/domain";
import type { DesignTool } from "./types.js";
import {
  ageWords,
  checkRange,
  CURSOR_SCHEMA,
  cursorField,
  dateField,
  encodeCursor,
  isErr,
  keyCursor,
  limitField,
  limitSchema,
  localDateOf,
  localTimeOf,
  pagedAnswer,
  parseInput,
  plural,
  READ_ROLES,
  athleteOf,
  untrusted,
  untrustedOrNull,
} from "./read-common.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const DEFAULT_DAYS = 14;
/** What an answer can be about (`athlete_answers.subject_kind`). */
const SUBJECT_KINDS = ["region", "muscle", "focus_area", "exercise", "workout", "performed_session", "condition"] as const;
/** A value an answer holds as an id or a chip, plain; anything else (a typed word) marked. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

const input = z
  .object({
    question: z.string().min(1).max(60).optional(),
    area: z.string().min(1).max(120).optional(),
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
      area: { type: "string", description: "What answers are about: an answer's subject (a region, muscle, focus area, exercise or workout id)." },
      since: { type: "string", description: `A local date, YYYY-MM-DD. Default: ${DEFAULT_DAYS} days ago.` },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.6,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(input, raw, "optionally question, area, since (YYYY-MM-DD), limit and cursor");
    if (isErr(p)) return p;
    const at = keyCursor(p.cursor, 3);
    if (isErr(at)) return at;
    const athlete = await athleteOf(ctx);
    const today = athlete.today;
    const since = p.since ?? addDays(today, -(DEFAULT_DAYS - 1));
    const bad = checkRange(since, today, { from: "since", to: "today" });
    if (bad) return bad;
    // The subject as the answers say it; "kind:id" (how an answer once read) is accepted too.
    const [areaKind, areaId] = p.area?.includes(":") && (SUBJECT_KINDS as readonly string[]).includes(p.area.split(":")[0]!)
      ? [p.area.split(":")[0]!, p.area.slice(p.area.indexOf(":") + 1)]
      : [null, p.area];
    const a = athleteAnswers;
    const limit = p.limit ?? DEFAULT_LIMIT;
    const rows = await ctx.db
      .select({
        id: a.id,
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
          ...(areaId ? [eq(a.subjectId, areaId)] : []),
          ...(areaKind ? [eq(a.subjectKind, areaKind)] : []),
          ...(at ? [sql`(${a.localDate}, ${a.at}, ${a.id}) <= (${at[0]}, ${at[1]}, ${at[2]})`] : []),
        ),
      )
      .orderBy(desc(a.localDate), desc(a.at), desc(a.id))
      .limit(limit + 1);
    const what = `${p.question ? `${p.question} ` : ""}answers${p.area ? ` about ${p.area}` : ""}`;
    return pagedAnswer({
      source: "the athlete's check-in answers and feedback",
      now: ctx.now,
      missing: [...athlete.missing, ...(rows.length === 0 && !at ? [`no ${what} since ${since}`] : [])],
      rows,
      limit,
      render: (r) => {
        const text = untrustedOrNull(r.text);
        const expires = localDateOf(athlete.tz, r.expiresAt);
        return {
          date: r.date,
          time: localTimeOf(athlete.tz, r.at),
          question: r.question,
          ...(r.subject ? { subject: ID.test(r.subject) ? r.subject : untrusted(r.subject) } : {}),
          ...(r.kind ? { subjectKind: r.kind } : {}),
          ...(r.value !== null ? { value: r.value } : {}),
          ...(r.choice !== null ? { choice: ID.test(r.choice) ? r.choice : untrusted(r.choice) } : {}),
          ...(text ? { text } : {}),
          source: r.source,
          age: ageWords(r.date, today),
          ...(expires && expires < today ? { expired: true } : {}),
        };
      },
      cursorOf: (r) => encodeCursor([r.date, r.at, r.id]),
      data: (answers) => ({ since, answers }),
      summary: (shown) => (rows.length ? `Read ${plural(shown, "answer")} since ${dayLabel(since)}` : `Found no ${what} since ${dayLabel(since)}`),
    });
  },
};
