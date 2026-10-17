/**
 * THE BODY CHECK (the new shape, 2026-10-17; design §4): "How's your body?" on the Today card — Fresh · A bit heavy ·
 * Sore somewhere, Sore with a small area picker. No AI anywhere in it.
 *
 * THE ANSWER is the athlete's, kept in their answers store (`athlete_answers`, principles §5.3) as a check-in
 * (`source 'checkin'`) on their local today, tied to the session it was given on (`workout_id`):
 *  - one `body_feel` row — `value_choice` fresh | heavy | sore, about the workout (`subject_kind 'workout'`), fresh for
 *    the day: `bc:<workout>:<date>`;
 *  - for Sore, one `soreness` row per area, by area (a library region, or a switched-on condition profile — the subject
 *    kinds the store already knows), fresh for soreness's days (record-answer.ts `CHECKIN_QUESTIONS`):
 *    `bc:<workout>:<date>:<area>`.
 * A changed answer replaces the day's rows (one batch); the same answer again writes nothing.
 *
 * THE CHIPS CAN CHANGE until the session starts: the session must be the athlete's, live, today's, still scheduled, and —
 * an app session — neither started nor done nor locked to the watch. Otherwise the check is closed (`open: false`; a
 * write is refused).
 *
 * Statements: the view reads three (the session with its lock and the switched-on conditions, the answer, the
 * adaptation); an answer adds its write (one batch) — pinned in body-check.test.ts.
 */
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { athleteAnswers, plannedWorkouts, sessionBuilds, userConditions } from "@rg/database";
import { appAuthoredRow, type UserPreferences } from "@rg/domain";
import { isProfileId, label as vocab, profileById } from "@rg/exercise-library";
import { insertBatches, runAtomically, type Db } from "./db.js";
import { freshThrough } from "./design-tools/record-answer.js";

/** The three answers, in the card's order. */
export const BODY_FEELS = ["fresh", "heavy", "sore"] as const;
export type BodyFeel = (typeof BODY_FEELS)[number];

/** The answers store's question for the check itself. */
export const BODY_QUESTION = "body_feel";

/**
 * The body's areas the picker offers, head to foot — library regions (record-answer's areas), less the ones another
 * name already covers or a picker has no use for (`jaw`: a condition's own; `thoracic`, `lats`: the upper back;
 * `full-body`).
 */
export const BODY_REGIONS = [
  "neck", "shoulders", "upper-back", "chest", "arms", "core", "low-back", "hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet",
] as const;

/** One area the picker offers: its id (a region, or a condition profile's) and its words. */
export interface BodyArea {
  id: string;
  label: string;
}

/** What the answer did to the day's session (the card says it in words; `bodyLine` in the UI). */
export type BodyChange = null;

/** What the Today card reads. */
export interface BodyCheckView {
  workoutId: string;
  /** Today's answer for this session, or null. `areas` in the picker's order (Sore only). */
  answer: { feel: BodyFeel; areas: string[] } | null;
  change: BodyChange;
  /** The chips can still change: the session hasn't started, and its day is today. */
  open: boolean;
  /** What the area picker offers: the body's regions, then each condition switched on. */
  areas: BodyArea[];
}

export interface BodyCheckOutcome {
  view: BodyCheckView;
  /** The session's calendar block changed (the route hands the calendar its sync). */
  calendarChanged: boolean;
  /** A watch write is queued for the client to drain (`POST /api/coach/drain`, as after an approve). */
  coachDrain: boolean;
}

export interface BodyCheckCtx {
  today: string;
  now: string;
  prefs: UserPreferences;
}

export interface BodyAnswer {
  feel: BodyFeel;
  areas?: readonly string[];
}

/** Not this athlete's live session. */
export class BodyCheckNotFoundError extends Error {
  constructor() {
    super("not_found");
  }
}

/** The session isn't today's, or has started, or is done: its check can't change. */
export class BodyCheckClosedError extends Error {
  constructor() {
    super("closed");
  }
}

/** An answer the check doesn't take (an unknown area, areas without Sore, Sore without an area). */
export class BodyCheckInvalidError extends Error {
  constructor(readonly why: string) {
    super("invalid");
  }
}

/** The session as the check reads it: its row, whether a build of it is locked, the conditions switched on. */
interface Subject {
  row: Pick<
    typeof plannedWorkouts.$inferSelect,
    "id" | "origin" | "category" | "sport" | "title" | "effectiveDate" | "completionState" | "contentState"
  >;
  locked: boolean;
  conditions: string[];
}

const answerId = (workoutId: string, date: string): string => `bc:${workoutId}:${date}`;

/** The session, its lock and the athlete's switched-on conditions, in one read; null when it isn't theirs or is gone. */
async function loadSubject(db: Db, userId: string, workoutId: string): Promise<Subject | null> {
  const pw = plannedWorkouts;
  const [r] = await db
    .select({
      id: pw.id,
      origin: pw.origin,
      category: pw.category,
      sport: pw.sport,
      title: pw.title,
      effectiveDate: pw.effectiveDate,
      completionState: pw.completionState,
      contentState: pw.contentState,
      locked: sql<number>`exists (select 1 from ${sessionBuilds} where ${and(eq(sessionBuilds.workoutId, pw.id), isNotNull(sessionBuilds.lockedAt))})`,
      conditions: sql<string | null>`(select group_concat(${userConditions.profileId}) from ${userConditions} where ${and(
        eq(userConditions.userId, userId),
        eq(userConditions.active, true),
      )})`,
    })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId), sql`${pw.archivedAt} is null`))
    .limit(1);
  if (!r) return null;
  const { locked, conditions, ...row } = r;
  return {
    row,
    locked: Boolean(locked),
    conditions: [...new Set((conditions ?? "").split(",").filter(isProfileId))].sort(),
  };
}

/** Can the check still change? Today's, still scheduled, and an app session neither started nor done nor locked. */
function openOf(s: Subject, today: string): boolean {
  const { row } = s;
  if (row.effectiveDate !== today || row.completionState !== "scheduled") return false;
  if (appAuthoredRow(row) && (row.contentState === "started" || row.contentState === "done" || s.locked)) return false;
  return true;
}

/** The picker's areas for an athlete with these conditions switched on. */
export function bodyAreas(conditions: readonly string[]): BodyArea[] {
  return [
    ...BODY_REGIONS.map((id) => ({ id, label: vocab(id) })),
    ...conditions.filter(isProfileId).map((id) => ({ id, label: profileById(id).check.label })),
  ];
}

/** The answer as the check keeps it: its areas known, deduplicated and in the picker's order; else why not. */
function normalized(input: BodyAnswer, areas: readonly BodyArea[]): { feel: BodyFeel; areas: string[] } {
  if (!(BODY_FEELS as readonly string[]).includes(input.feel)) throw new BodyCheckInvalidError("feel: fresh, heavy or sore");
  const asked = [...new Set(input.areas ?? [])];
  if (input.feel !== "sore") {
    if (asked.length > 0) throw new BodyCheckInvalidError("areas only with sore");
    return { feel: input.feel, areas: [] };
  }
  const known = areas.map((a) => a.id);
  const unknown = asked.filter((a) => !known.includes(a));
  if (unknown.length > 0) throw new BodyCheckInvalidError(`unknown area: ${unknown.join(", ")}`);
  if (asked.length === 0) throw new BodyCheckInvalidError("sore needs an area");
  return { feel: "sore", areas: known.filter((a) => asked.includes(a)) };
}

/** Today's answer for the session, from its rows (null when none). */
async function readAnswer(db: Db, userId: string, workoutId: string, today: string, conditions: readonly string[]) {
  const a = athleteAnswers;
  const id = answerId(workoutId, today);
  const rows = await db
    .select({ id: a.id, questionId: a.questionId, valueChoice: a.valueChoice, subjectId: a.subjectId })
    .from(a)
    .where(and(eq(a.userId, userId), eq(a.workoutId, workoutId), eq(a.localDate, today), sql`(${a.id} = ${id} or substr(${a.id}, 1, ${id.length + 1}) = ${`${id}:`})`));
  const main = rows.find((r) => r.id === id && r.questionId === BODY_QUESTION);
  const feel = main?.valueChoice;
  if (!feel || !(BODY_FEELS as readonly string[]).includes(feel)) return null;
  const order = bodyAreas(conditions).map((x) => x.id);
  const areas = rows.filter((r) => r.id !== id && r.questionId === "soreness" && r.subjectId).map((r) => r.subjectId!);
  return { feel: feel as BodyFeel, areas: feel === "sore" ? order.filter((x) => areas.includes(x)) : [] };
}

/** The day's answer rows replaced by these (one batch: the delete, then the inserts). */
async function writeAnswer(db: Db, userId: string, workoutId: string, answer: { feel: BodyFeel; areas: string[] }, ctx: BodyCheckCtx): Promise<void> {
  const a = athleteAnswers;
  const id = answerId(workoutId, ctx.today);
  const common = { userId, source: "checkin", localDate: ctx.today, at: ctx.now, workoutId };
  const rows: Array<typeof athleteAnswers.$inferInsert> = [
    { id, questionId: BODY_QUESTION, subjectKind: "workout", subjectId: workoutId, valueChoice: answer.feel, expiresAt: ctx.today, ...common },
    ...answer.areas.map((area) => ({
      id: `${id}:${area}`,
      questionId: "soreness",
      subjectKind: isProfileId(area) ? "condition" : "region",
      subjectId: area,
      valueChoice: null,
      expiresAt: freshThrough("soreness", ctx.today),
      ...common,
    })),
  ];
  await runAtomically(db, [
    db.delete(a).where(and(eq(a.userId, userId), sql`(${a.id} = ${id} or substr(${a.id}, 1, ${id.length + 1}) = ${`${id}:`})`)),
    ...insertBatches(rows).map((batch) => db.insert(a).values(batch)),
  ]);
}

const sameAnswer = (x: { feel: BodyFeel; areas: string[] } | null, y: { feel: BodyFeel; areas: string[] }): boolean =>
  x !== null && x.feel === y.feel && x.areas.length === y.areas.length && x.areas.every((a, i) => a === y.areas[i]);

/** `GET /api/today/body?workout=`: the check as the card shows it. Throws `BodyCheckNotFoundError`. */
export async function readBodyCheck(db: Db, userId: string, workoutId: string, ctx: Pick<BodyCheckCtx, "today">): Promise<BodyCheckView> {
  const s = await loadSubject(db, userId, workoutId);
  if (!s) throw new BodyCheckNotFoundError();
  const answer = await readAnswer(db, userId, workoutId, ctx.today, s.conditions);
  return { workoutId, answer, change: null, open: openOf(s, ctx.today), areas: bodyAreas(s.conditions) };
}

/**
 * `POST /api/today/body` `{workoutId, feel, areas?}`: keep the answer, and adapt the day as it asks. Throws
 * `BodyCheckNotFoundError`, `BodyCheckInvalidError`, `BodyCheckClosedError`.
 */
export async function answerBodyCheck(db: Db, userId: string, workoutId: string, input: BodyAnswer, ctx: BodyCheckCtx): Promise<BodyCheckOutcome> {
  const s = await loadSubject(db, userId, workoutId);
  if (!s) throw new BodyCheckNotFoundError();
  const areas = bodyAreas(s.conditions);
  const answer = normalized(input, areas);
  if (!openOf(s, ctx.today)) throw new BodyCheckClosedError();
  const current = await readAnswer(db, userId, workoutId, ctx.today, s.conditions);
  if (!sameAnswer(current, answer)) await writeAnswer(db, userId, workoutId, answer, ctx);
  return { view: { workoutId, answer, change: null, open: true, areas }, calendarChanged: false, coachDrain: false };
}
