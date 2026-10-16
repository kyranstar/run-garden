/**
 * list_workouts(from, to, q?) and get_workout(id) — document workouts (Stage 3 spec §4).
 *
 *  - list_workouts: the planned rows with a document between two dates, newest first, with their intent — the
 *    Studio's searchable list ("like last week's"; every word of `q` in the title or the intent), each with its day by
 *    name and how far from today, and — gone by while still only scheduled — read_plan's `passed` (fix wave 13, I6).
 *    A page that fits, paged by key. Two statements: the athlete (today, the timezone), then the page.
 *  - get_workout: one workout's document — every word in it marked (a document is written by the client, its `source`
 *    too, so nothing tells the athlete's words from the app's), and every id or vocabulary value that is not plainly
 *    one (a move the library does not know, an id with spaces in it) marked as well — its revision, what is derived
 *    from it (`deriveDoc`), what was done in it (read_history's lines, with their ids) and the feedback on it. Archived
 *    rows and other accounts' are not found. Two statements: the athlete with the row, then what was done and the
 *    feedback in one read.
 */
import { and, between, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, athleteAnswers, performedSessions, plannedWorkouts } from "@rg/database";
import { dayLabel, dayRangeLabel, parseStoredWorkoutDoc, type WorkoutDoc, type WorkoutDose, type WorkoutItem } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { likeWordPatterns } from "../like-pattern.js";
import type { DesignTool } from "./types.js";
import {
  answer,
  checkRange,
  CURSOR_SCHEMA,
  cursorField,
  DATE_SCHEMA,
  dateField,
  encodeCursor,
  isErr,
  keyCursor,
  limitField,
  limitSchema,
  pagedAnswer,
  parsedJson,
  parseInput,
  plural,
  READ_ROLES,
  athleteOf,
  dayWords,
  readAthlete,
  readTagged,
  refuse,
  untrusted,
  type Untrusted,
} from "./read-common.js";
import { hasPassed, INTENT_SQL, ORIGIN_WORDS, PASSED_WORDS, planClock, STATUS_WORDS } from "./read-plan.js";
import { doneEntries, doneTerms, knownMove, sessionsWhere } from "./read-sessions.js";

const pw = plannedWorkouts;
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;
const MINUTES = sql<number | null>`coalesce(${pw.sourceEstimatedDurationSeconds}, ${pw.fallbackEstimatedDurationSeconds}, ${pw.calendarBlockDurationSeconds})`;

const listInput = z
  .object({ from: dateField, to: dateField, q: z.string().max(80).optional(), limit: limitField(MAX_LIMIT).optional(), cursor: cursorField.optional() })
  .strict();

export const listWorkouts: DesignTool = {
  name: "list_workouts",
  description: "Document workouts (past and planned) between two dates, newest first, with their intent; q searches titles and intents.",
  inputSchema: {
    type: "object",
    properties: {
      from: DATE_SCHEMA,
      to: DATE_SCHEMA,
      q: { type: "string", description: "Words in the title or intent." },
      limit: limitSchema(DEFAULT_LIMIT, MAX_LIMIT),
      cursor: CURSOR_SCHEMA,
    },
    required: ["from", "to"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.2,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(listInput, raw, "from and to (YYYY-MM-DD), and optionally q, limit and cursor");
    if (isErr(p)) return p;
    const bad = checkRange(p.from, p.to);
    if (bad) return bad;
    // A page starts at its cursor's row (date, time, id; newest first), so a workout written meanwhile never shifts it.
    const at = keyCursor(p.cursor, 3);
    if (isErr(at)) return at;
    const words = likeWordPatterns(p.q);
    const limit = p.limit ?? DEFAULT_LIMIT;
    const athlete = await athleteOf(ctx);
    const clock = planClock(athlete, ctx.now);
    const rows = await ctx.db
      .select({
        id: pw.id,
        date: pw.effectiveDate,
        time: pw.effectiveTime,
        title: pw.title,
        intent: INTENT_SQL,
        state: pw.completionState,
        category: pw.category,
        origin: pw.origin,
        rev: pw.workoutDocRev,
        seconds: MINUTES,
      })
      .from(pw)
      .where(
        and(
          eq(pw.userId, ctx.userId),
          isNull(pw.archivedAt),
          isNotNull(pw.workoutDoc),
          between(pw.effectiveDate, p.from, p.to),
          // Every word, in the title or the intent.
          ...words.map((like) => or(sql`${pw.title} LIKE ${like} ESCAPE '\\'`, sql`${INTENT_SQL} LIKE ${like} ESCAPE '\\'`)!),
          ...(at ? [sql`(${pw.effectiveDate}, ${pw.effectiveTime}, ${pw.id}) <= (${at[0]}, ${at[1]}, ${at[2]})`] : []),
        ),
      )
      .orderBy(desc(pw.effectiveDate), desc(pw.effectiveTime), desc(pw.id))
      .limit(limit + 1);
    return pagedAnswer({
      source: "the plan's document workouts",
      now: ctx.now,
      missing: [...athlete.missing, ...(rows.length === 0 && !at ? [`no document workouts from ${p.from} to ${p.to}${p.q ? ` matching "${p.q}"` : ""}`] : [])],
      rows,
      limit,
      render: (r) => {
        const passed = hasPassed(r, clock);
        const minutes = typeof r.seconds === "number" && r.seconds > 0 ? Math.round(r.seconds / 60) : null;
        return {
          id: r.id,
          date: r.date,
          day: dayWords(r.date, clock.today),
          time: r.time,
          ...(passed ? { plannedMinutes: minutes } : { minutes }),
          status: STATUS_WORDS[r.state] ?? r.state,
          ...(passed ? { passed: PASSED_WORDS } : {}),
          ...(r.origin ? { origin: ORIGIN_WORDS[r.origin] ?? r.origin } : {}),
          rev: r.rev,
          title: untrusted(r.title),
          intent: untrusted(typeof r.intent === "string" ? r.intent : ""),
        };
      },
      cursorOf: (r) => encodeCursor([r.date, r.time, r.id]),
      data: (workouts) => ({ from: p.from, to: p.to, workouts }),
      summary: (shown) => `Listed ${plural(shown, "workout")}, ${dayRangeLabel(p.from, p.to)}${p.q ? ", matching the search" : ""}`,
    });
  },
};

// ── One workout ─────────────────────────────────────────────────────────────────────────────────────────────────────

const marked = (key: string, text: string | undefined): Record<string, Untrusted> => (text ? { [key]: untrusted(text) } : {});

/** An id or vocabulary value as the document holds it: plain when it reads as one, marked when it does not. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const idOr = (s: string): string | Untrusted => (ID.test(s) ? s : untrusted(s));
/** A move id: plain when the library (or the COROS catalog) knows it, marked when it does not. */
const moveId = (id: string): string | Untrusted => (knownMove(id) ? id : untrusted(id));

/** A dose as it is, but the weight as the athlete typed it ("35 lb") marked. */
function markDose(dose: WorkoutDose): Record<string, unknown> {
  const { load, ...rest } = dose;
  return { ...rest, ...(load === undefined ? {} : load === "bodyweight" ? { load } : { load: { typed: untrusted(load.typed), kg: load.kg } }) };
}

function markItem(item: WorkoutItem): Record<string, unknown> {
  switch (item.kind) {
    case "exercise":
      return {
        kind: item.kind,
        libraryId: moveId(item.libraryId),
        dose: markDose(item.dose),
        ...(item.side ? { side: item.side } : {}),
        ...(item.test ? { test: item.test.keyResultId !== undefined ? { keyResultId: idOr(item.test.keyResultId) } : {} } : {}),
        ...(item.alternates ? { alternates: item.alternates.map((a) => ({ libraryId: moveId(a.libraryId), ...marked("why", a.why) })) } : {}),
        ...marked("why", item.why),
        ...marked("progression", item.progression),
        ...marked("cue", item.cue),
      };
    case "free_exercise":
      return {
        kind: item.kind,
        dose: markDose(item.dose),
        ...(item.coros ? { coros: item.coros.key !== undefined ? { key: idOr(item.coros.key) } : {} } : {}),
        name: untrusted(item.name),
        ...marked("why", item.why),
        ...marked("cue", item.cue),
      };
    case "run": {
      const { typed, ...target } = item.target;
      return { kind: item.kind, effort: item.effort, target: { ...target, ...marked("typed", typed) }, ...marked("why", item.why), ...marked("cue", item.cue) };
    }
    case "rest":
      return { ...item };
  }
}

/**
 * The document as the model may read it: its structure and numbers as they are, every word marked, and every id or
 * vocabulary value that is not plainly one marked too (the stored document passed its schema, which bounds lengths,
 * not words).
 */
export function markedDoc(doc: WorkoutDoc): Record<string, unknown> {
  const { setting, basedOn, source } = doc;
  return {
    title: untrusted(doc.title),
    intent: {
      summary: untrusted(doc.intent.summary),
      goals: doc.intent.goals,
      focus: doc.intent.focus.map(idOr),
      effort: doc.intent.effort,
      ...(doc.intent.objectiveIds ? { objectiveIds: doc.intent.objectiveIds.map(idOr) } : {}),
    },
    ...(setting
      ? {
          setting: {
            ...(setting.placeId !== undefined ? { placeId: idOr(setting.placeId) } : {}),
            ...(setting.equipment ? { equipment: setting.equipment.map(idOr) } : {}),
            ...(setting.targetMinutes !== undefined ? { targetMinutes: setting.targetMinutes } : {}),
          },
        }
      : {}),
    parts: doc.parts.map((part) => ({
      purpose: part.purpose,
      format: part.format,
      ...(part.rounds !== undefined ? { rounds: part.rounds } : {}),
      ...(part.restBetweenRoundsSec !== undefined ? { restBetweenRoundsSec: part.restBetweenRoundsSec } : {}),
      ...marked("why", part.why),
      items: part.items.map(markItem),
    })),
    source: { kind: source.kind, ...marked("ref", source.ref) },
    ...(basedOn ? { basedOn: { kind: basedOn.kind, id: idOr(basedOn.id), ...(basedOn.rev !== undefined ? { rev: basedOn.rev } : {}) } } : {}),
    ...marked("notes", doc.notes),
  };
}

const getInput = z.object({ id: z.string().min(1).max(120) }).strict();

const notFound = (id: string) =>
  refuse("not_found", `No workout with id ${JSON.stringify(id)} in the athlete's plan.`, "Use an id from list_workouts or read_plan.");

export const getWorkout: DesignTool = {
  name: "get_workout",
  description: "One planned workout: its document, revision, derived minutes, what was done in it and the feedback on it.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", description: "A workout id from list_workouts or read_plan." } },
    required: ["id"],
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(getInput, raw, "the workout's id");
    if (isErr(p)) return p;
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      row: sql`(select json_object('date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'state', ${pw.completionState}, 'category', ${pw.category}, 'origin', ${pw.origin},
          'content', ${pw.contentState}, 'rev', ${pw.workoutDocRev}, 'doc', ${pw.workoutDoc})
          from ${pw} where ${pw.id} = ${p.id} and ${pw.userId} = ${ctx.userId} and ${pw.archivedAt} is null)`,
    });
    const row = parsedJson(extra.row) as { date?: string; time?: string; state?: string; category?: string; origin?: string | null; content?: string | null; rev?: number | null; doc?: string | null } | null;
    if (!row || typeof row.date !== "string") return notFound(p.id);

    const scope = sessionsWhere(ctx.userId, sql`${performedSessions.workoutId} = ${p.id}`);
    const a = athleteAnswers;
    const rows = await readTagged(ctx.db, [
      ...doneTerms(ctx.userId, scope, {
        activitiesWhere: sql`${activities.id} in (select ${performedSessions.activityId} from ${performedSessions} where ${scope})`,
      }),
      sql`select 'f' as t, json_object('date', ${a.localDate}, 'at', ${a.at}, 'q', ${a.questionId}, 'num', ${a.valueNum}, 'choice', ${a.valueChoice},
          'text', ${a.text}, 'source', ${a.source}) as j
          from ${a} where ${a.userId} = ${ctx.userId} and (${a.workoutId} = ${p.id} or (${a.subjectKind} = 'workout' and ${a.subjectId} = ${p.id}))`,
    ]);
    const actuals = doneEntries(
      { sessions: rows.get("s"), sets: rows.get("x"), checks: rows.get("c"), activities: rows.get("a") },
      { tz: athlete.tz, units: athlete.prefs.units, weightUnit: athlete.prefs.weightUnit, today: athlete.today },
    )
      .filter((e) => e.kind === "session")
      .map((e) => e.entry);
    const feedback = (rows.get("f") ?? [])
      .sort((x, y) => String(y.at).localeCompare(String(x.at)))
      .map((f) => ({
        date: f.date,
        question: f.q,
        ...(typeof f.num === "number" ? { value: f.num } : {}),
        ...(typeof f.choice === "string" ? { choice: idOr(f.choice) } : {}),
        ...(typeof f.text === "string" && f.text.trim() ? { text: untrusted(f.text) } : {}),
        source: f.source,
      }));

    const doc = parseStoredWorkoutDoc(row.doc ?? null);
    const missing: string[] = [];
    if (!doc) {
      missing.push(row.doc ? "the stored document does not read" : row.content === "outline" ? "no document: an outline built on its day" : "no document");
    }
    const derived = doc ? deriveDoc(doc, EXERCISES) : null;
    return answer({
      source: "the workout's row and document, logged sessions and the athlete's feedback",
      now: ctx.now,
      missing,
      data: {
        id: p.id,
        date: row.date,
        day: dayWords(row.date, athlete.today),
        time: row.time,
        status: STATUS_WORDS[row.state ?? ""] ?? row.state,
        ...(hasPassed({ date: row.date, time: row.time ?? null, state: row.state ?? null, category: row.category ?? null }, planClock(athlete, ctx.now)) ? { passed: PASSED_WORDS } : {}),
        ...(row.origin ? { origin: ORIGIN_WORDS[row.origin] ?? row.origin } : {}),
        rev: row.rev ?? null,
        derived: derived ? { minutes: derived.estimatedMinutes, discipline: derived.discipline, category: derived.category, mode: derived.mode } : null,
        actuals,
        feedback,
        document: doc ? markedDoc(doc) : null,
      },
      summary: `Read the workout on ${dayLabel(row.date)}${actuals.length ? " and what was done in it" : ""}`,
    });
  },
};
