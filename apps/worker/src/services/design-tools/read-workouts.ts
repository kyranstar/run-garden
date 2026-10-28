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
 *    feedback in one read. Or a suggestion (fix wave 13, R8): `{ proposalId, opId }` from read_proposals gives that
 *    designed workout's document, minutes, review mean and how the athlete decided it — after a decline, "the same but
 *    60 min" starts from it (`basedOn: { kind: "proposal", id }`). One statement.
 */
import { and, between, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { activities, athleteAnswers, coachProposals, performedSessions, plannedWorkouts } from "@rg/database";
import { dayLabel, dayRangeLabel, parseStoredWorkoutDoc, type WorkoutDoc, type WorkoutDose, type WorkoutItem } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { accountLibraryFrom, personalMovesSql } from "../account-library.js";
import { likeWordPatterns } from "../like-pattern.js";
import { reviewMeanOf } from "../design-orchestrate.js";
import { isDocWorkoutOp, opIdOf } from "../proposal-kinds.js";
import type { DocWorkoutOp } from "./propose.js";
import { decided } from "./read-proposals.js";
import type { DesignTool, ToolContext, ToolErr, ToolOk } from "./types.js";
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
  parsedArray,
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
import { hasPassed, INTENT_SQL, listRevisable, nullOriginWords, ORIGIN_WORDS, PASSED_WORDS, planClock, revisableWords, STATUS_WORDS } from "./read-plan.js";
import { revisabilityIn } from "../doc-workouts.js";
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
  description:
    "Document workouts (past and planned) between two dates, newest first, with their intent; q searches titles and intents. Each says if it is revisable (a run is told by sport and category here).",
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
  cpuWeight: 0.3,
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
        sport: pw.sport,
        content: pw.contentState,
        source: pw.sourceWorkoutId,
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
        const originWords = r.origin ? (ORIGIN_WORDS[r.origin] ?? r.origin) : nullOriginWords(r.id, r.source);
        const minutes = typeof r.seconds === "number" && r.seconds > 0 ? Math.round(r.seconds / 60) : null;
        return {
          id: r.id,
          date: r.date,
          day: dayWords(r.date, clock.today),
          time: r.time,
          ...(passed ? { plannedMinutes: minutes } : { minutes }),
          status: STATUS_WORDS[r.state] ?? r.state,
          ...(passed ? { passed: PASSED_WORDS } : {}),
          ...(originWords ? { origin: originWords } : {}),
          rev: r.rev,
          revisable: listRevisable({ ...r, hasDoc: true }, clock.today),
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
/** A move id: plain when the library — the account's, given (one of the athlete's own moves) — or the COROS catalog knows it, marked when it does not. */
const moveId = (id: string, library?: readonly ExerciseRecord[]): string | Untrusted => (knownMove(id, library) ? id : untrusted(id));

/** A dose as it is, but the weight as the athlete typed it ("35 lb") marked. */
function markDose(dose: WorkoutDose): Record<string, unknown> {
  const { load, ...rest } = dose;
  return { ...rest, ...(load === undefined ? {} : load === "bodyweight" ? { load } : { load: { typed: untrusted(load.typed), kg: load.kg } }) };
}

function markItem(item: WorkoutItem, library?: readonly ExerciseRecord[]): Record<string, unknown> {
  switch (item.kind) {
    case "exercise":
      return {
        kind: item.kind,
        libraryId: moveId(item.libraryId, library),
        dose: markDose(item.dose),
        ...(item.side ? { side: item.side } : {}),
        ...(item.test ? { test: item.test.keyResultId !== undefined ? { keyResultId: idOr(item.test.keyResultId) } : {} } : {}),
        ...(item.alternates ? { alternates: item.alternates.map((a) => ({ libraryId: moveId(a.libraryId, library), ...marked("why", a.why) })) } : {}),
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
 * not words). `library`: the account's (`all`), when the read has it — an id of one of the athlete's own moves is then plain.
 */
export function markedDoc(doc: WorkoutDoc, library?: readonly ExerciseRecord[]): Record<string, unknown> {
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
      items: part.items.map((item) => markItem(item, library)),
    })),
    source: { kind: source.kind, ...marked("ref", source.ref) },
    ...(basedOn ? { basedOn: { kind: basedOn.kind, id: idOr(basedOn.id), ...(basedOn.rev !== undefined ? { rev: basedOn.rev } : {}) } } : {}),
    ...marked("notes", doc.notes),
  };
}

// A planned workout by its id, or a suggestion by its proposal and op (fix wave 13, R8) — one or the other, whole.
const getInput = z
  .object({ id: z.string().min(1).max(120).optional(), proposalId: z.string().min(1).max(200).optional(), opId: z.string().min(1).max(200).optional() })
  .strict()
  .refine((x) => (x.id !== undefined) !== (x.proposalId !== undefined || x.opId !== undefined) && (x.id !== undefined || (x.proposalId !== undefined && x.opId !== undefined)), {
    message: "give either id (a planned workout) or both proposalId and opId (a suggestion), not both",
  });

/**
 * A suggestion read back (fix wave 13, R8): after a decline, "the same, but 60 minutes" starts from what was declined,
 * not from nothing. The designed workout `opId` of the athlete's proposal `proposalId` (never a rehearsal's): its
 * document (marked as get_workout marks one), day, minutes and mode, its review's mean and rounds, and how it ended in
 * read_proposals' words (open while the athlete hasn't decided). One statement: the athlete with the proposal.
 */
async function suggestion(ctx: ToolContext, proposalId: string, opId: string): Promise<ToolOk | ToolErr> {
  const c = coachProposals;
  const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
    proposal: sql`(select json_object('status', ${c.status}, 'ops', ${c.ops}) from ${c}
        where ${c.id} = ${proposalId} and ${c.userId} = ${ctx.userId} and ${c.status} != 'rehearsal')`,
    library: personalMovesSql(ctx.userId),
  });
  const library = await accountLibraryFrom(ctx.db, ctx.userId, extra.library);
  const held = parsedJson(extra.proposal) as { status?: string; ops?: unknown } | null;
  const ops = parsedArray(typeof held?.ops === "string" ? held.ops : null);
  // An op is read as stored: one written before ops carried their run (`by`) has no opId and is never this one.
  const op = ops.find(
    (o): o is DocWorkoutOp & { outcome?: Record<string, unknown> } =>
      isDocWorkoutOp(o) && typeof (o as { by?: { runId?: unknown } }).by?.runId === "string" && opIdOf(o as DocWorkoutOp) === opId,
  );
  if (!held || !op) {
    return refuse(
      "not_found",
      `No suggested workout ${JSON.stringify(opId)} in the athlete's proposal ${JSON.stringify(proposalId)}.`,
      "Use a proposalId and the opId of one of its designed workouts from read_proposals.",
    );
  }
  const o = op.outcome;
  const outcome = o
    ? decided({
        outcome: o.status,
        edited: o.edited,
        moved: o.moved,
        wDate: (o.written as { date?: unknown } | undefined)?.date,
        wTime: (o.written as { time?: unknown } | undefined)?.time,
        reason: o.reason,
        why: o.why,
      })
    : {};
  const d = op.derived ?? {};
  const mean = reviewMeanOf(op);
  const doc = parseStoredWorkoutDoc(JSON.stringify(op.doc));
  return answer({
    source: "the coach's proposal: the suggested workout, its review and how the athlete decided it",
    now: ctx.now,
    missing: [...athlete.missing, ...(doc ? [] : ["the suggested document does not read"])],
    data: {
      proposalId,
      opId,
      date: op.date,
      day: dayWords(op.date, athlete.today),
      ...(op.time ? { time: op.time } : {}),
      target: op.target,
      derived: { minutes: typeof d.minutes === "number" ? d.minutes : null, mode: typeof d.mode === "string" ? d.mode : null },
      review: op.review ? { mean, rounds: op.review.rounds } : null,
      ...(Object.keys(outcome).length ? outcome : { outcome: "open" }),
      document: doc ? markedDoc(doc, library.all) : null,
    },
    summary: `Read the suggestion for ${dayLabel(op.date)}`,
  });
}

const notFound = (id: string) =>
  refuse("not_found", `No workout with id ${JSON.stringify(id)} in the athlete's plan.`, "Use an id from list_workouts or read_plan.");

export const getWorkout: DesignTool = {
  name: "get_workout",
  description:
    "One planned workout by id (document, rev, minutes, what was done, feedback, whether revisable), or a suggestion by proposalId and opId (its document, minutes, review, how it ended). Build on one: basedOn { kind: proposal, id: proposalId }.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "A workout id from list_workouts or read_plan." },
      proposalId: { type: "string", description: "A suggestion's proposal id, from read_proposals (with its opId)." },
      opId: { type: "string", description: "The designed workout's opId in that proposal, from read_proposals." },
    },
    additionalProperties: false,
  },
  statementCost: 2,
  cpuWeight: 0.4,
  roles: READ_ROLES,
  async run(ctx, raw) {
    const p = parseInput(getInput, raw, "a workout's id, or a suggestion's proposalId and opId");
    if (isErr(p)) return p;
    if (p.id === undefined) return suggestion(ctx, p.proposalId!, p.opId!);
    const { athlete, extra } = await readAthlete(ctx.db, ctx.userId, ctx.now, {
      row: sql`(select json_object('date', ${pw.effectiveDate}, 'time', ${pw.effectiveTime}, 'state', ${pw.completionState}, 'category', ${pw.category}, 'sport', ${pw.sport}, 'origin', ${pw.origin}, 'source', ${pw.sourceWorkoutId},
          'content', ${pw.contentState}, 'rev', ${pw.workoutDocRev}, 'doc', ${pw.workoutDoc})
          from ${pw} where ${pw.id} = ${p.id} and ${pw.userId} = ${ctx.userId} and ${pw.archivedAt} is null)`,
      library: personalMovesSql(ctx.userId),
    });
    // The account's library, with the athlete: a document's own moves (one of the athlete's included) read by it.
    const library = await accountLibraryFrom(ctx.db, ctx.userId, extra.library);
    const row = parsedJson(extra.row) as { date?: string; time?: string; state?: string; category?: string; sport?: string | null; source?: string | null; origin?: string | null; content?: string | null; rev?: number | null; doc?: string | null } | null;
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
      { tz: athlete.tz, units: athlete.prefs.units, weightUnit: athlete.prefs.weightUnit, today: athlete.today, library: library.all },
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
    const originWords = row.origin ? (ORIGIN_WORDS[row.origin] ?? row.origin) : nullOriginWords(p.id, row.source ?? null);
    const derived = doc ? deriveDoc(doc, library.all) : null;
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
        ...(originWords ? { origin: originWords } : {}),
        rev: row.rev ?? null,
        revisable: revisableWords(
          revisabilityIn(
            { origin: row.origin ?? null, category: row.category ?? null, sport: row.sport ?? null, completionState: row.state ?? null, contentState: row.content ?? null, effectiveDate: row.date, workoutDoc: row.doc ?? null },
            athlete.today,
            library.all,
          ),
        ),
        derived: derived ? { minutes: derived.estimatedMinutes, discipline: derived.discipline, category: derived.category, mode: derived.mode } : null,
        actuals,
        feedback,
        document: doc ? markedDoc(doc, library.all) : null,
      },
      summary: `Read the workout on ${dayLabel(row.date)}${actuals.length ? " and what was done in it" : ""}`,
    });
  },
};
