/**
 * STARTING AND STOPPING A COURSE (plans with a purpose, spec §4.2, rulings R28 and R29). Nothing here names a course: all of
 * it reads `CourseDefinition`.
 *
 * ONE PLAN PER COURSE, ALWAYS. A start finds the plan by the course its settings name, whatever its id. Running, it stands
 * as it is: a retry changes nothing, and a start doesn't change the days of a plan that's running. Stopped, that same row
 * comes back with the days and the time asked for now, so its number goes on from the sessions done, the ones completed
 * without being written (a number and no document) among them. A revival keeps the plan's own words and any easing asked
 * for. A pause from before the stop doesn't outlive the new start. A new plan takes an id from the account and the course,
 * so two racing first starts make one row.
 *
 * WHAT'S ALREADY PLANNED (`startCourse`). Sessions from before courses existed sit in the Studio's bucket as document
 * workouts. One is a session of this course when its document's `source.ref` says `<course>-course:<n>`. Each comes to one of:
 *  - TAKEN IN: it moves to the plan with `course_session` = n and nothing else changes, so there's no new revision and no copy
 *    is sent again. That's a session completed or under way, whenever it was. Under way is the code's own meaning
 *    (`LOCKED_CONTENT`, what `revisability` calls under way and `removeDocWorkout` won't take): content started or done, or a
 *    performed session saved against it. Built isn't under way. Today or ahead, it's also one revised after it was planned,
 *    since removing it would lose the athlete's edit, and one skipped, whose day the athlete has already spoken for and which
 *    a removal can't take. Either holds its day and counts toward its week as any of the course's own does.
 *  - AHEAD: today or later and none of the above. It comes off through `removeDocWorkout`, a copy on the watch with it, so
 *    the course's own outline can take over.
 *  - LEFT: behind, and never done. It isn't a session done and it isn't ahead, so it stays where it is.
 * Placement runs once none is left ahead. Not before: an outline beside the session it replaces would be two on one day.
 *
 * STOPPING (`stopCourse`). The status goes first, so nothing is written for the plan from then on (the write's guard holds
 * to it). Then every session of the plan today or ahead comes off, its own or filed by the coach, unless it has started or
 * been saved. A revised one comes off too: unlike a pause, a stop is the athlete ending it, and nothing comes back to overwrite
 * the edit. What's behind stays, and so does what's already resolved. They go in this order, since a request may not fit them
 * all: documents first, soonest first, through `removeDocWorkout`, as these hold a copy on the watch and nothing else will
 * ever come for them; then the flexible outlines through placement's goal 0 pass (`placeSlotsWithin`), the same pass a
 * programme's retirement runs; then the outlines that pass rightly leaves for a plan that's merely changing its days, today's
 * and any moved or re-timed.
 *
 * WHY `program_replaced` (`BY_THE_PLAN`). Everything a stop or a start takes off is archived for that reason. It's the
 * plan's doing, not the athlete's, so a restart can bring the same row back on its day: a day whose slot says `user_removed`
 * is the athlete's and stays empty for good (`program-slots.ts`, rule 1).
 *
 * A REQUEST DOES WHAT FITS, and `more` says when something is left. Nothing is stored between requests: each reads what's
 * still there, so a repeated call carries on, and a stop whose client never comes back has its flexible outlines finished by
 * the hourly pass (`placeSlotsForAllPrograms` visits a stopped plan that still holds one). The rest wait for the next call. A
 * day's build on the wire this moment can't come off until it lands (`NotRemovableError`'s `sending`): that's `more` too,
 * and the next call takes it.
 *
 * A restore in progress: `restore_in_progress` before anything is written, or `RestoreInProgressError` from a removal once a
 * restore has begun part way.
 */
import { and, asc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { performedSessions, plannedWorkouts, programs } from "@rg/database";
import { courseConfigSchema, defaultOnEnd, DOC_ORIGINS, docOriginRow, type UserPreferences } from "@rg/domain";
import { courseDefinition, courseSessionOfRef } from "@rg/workout";
import { restoreInProgress } from "./account-state.js";
import { STILL_TO_DO } from "./course-sessions.js";
import { chunkIds, type Db } from "./db.js";
import { DocWorkoutNotFoundError, LOCKED_CONTENT, NotRemovableError, removeDocWorkout } from "./doc-workouts.js";
import { removeFromPlan } from "./plan-mutations.js";
import { placeSlotsWithin, RETRACT_COST, RETRACT_WRITTEN_COST, RUNNING_PASS_MIN, STOPPED_PASS_MIN } from "./program-slots.js";
import { FROZEN_STATES } from "./workout-doc-store.js";

type ProgramRow = typeof programs.$inferSelect;

const pw = plannedWorkouts;

/** Who a session taken off is recorded as, and why it left: the header's WHY. */
const BY_THE_PLAN = { source: "program_replace", archiveReason: "program_replaced" } as const;

interface PlanCtx {
  today: string;
  now: string;
  prefs: UserPreferences;
}

/** What a new plan of a course is called by: one per account per course. */
const coursePlanId = (userId: string, course: string): string => `course-${userId}-${course}`;

/**
 * The course's one plan, running: found and left as it is, revived, or made (the header's ONE PLAN PER COURSE). At most two
 * statements.
 */
async function theCoursePlan(db: Db, userId: string, input: { course: string; weekdays: number[]; time: string }, now: string): Promise<string> {
  const [found] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.kind, "course"), sql`json_extract(${programs.config}, '$.course') = ${input.course}`))
    .limit(1);
  const asked = { course: input.course, weekdays: input.weekdays, time: input.time };
  if (found) {
    if (found.status === "active" && found.archivedAt === null) return found.id;
    const stored = courseConfigSchema.safeParse(found.config);
    await db
      .update(programs)
      .set({ status: "active", archivedAt: null, pausedUntil: null, config: courseConfigSchema.parse({ ...(stored.success ? stored.data : {}), ...asked }), updatedAt: now })
      .where(and(eq(programs.id, found.id), eq(programs.userId, userId)));
    return found.id;
  }
  const definition = courseDefinition(input.course)!;
  const id = coursePlanId(userId, input.course);
  const disciplines = [...definition.disciplines];
  await db
    .insert(programs)
    .values({
      id,
      userId,
      kind: "course",
      name: definition.name,
      status: "active",
      disciplines,
      startDate: null,
      endDate: null,
      raceDate: null,
      source: null,
      config: courseConfigSchema.parse(asked),
      purpose: definition.purpose,
      brief: definition.brief,
      onEnd: defaultOnEnd("course", disciplines),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .onConflictDoNothing();
  return id;
}

/** A session is under way, or done: `LOCKED_CONTENT`, a performed session saved against it, or completed. */
const underWay = (r: { completion: string; content: string | null; performed: unknown }): boolean =>
  r.completion === "completed" || (LOCKED_CONTENT as readonly (string | null)[]).includes(r.content) || Boolean(r.performed);

/** The account's document workouts outside this plan that name this course, each as the header sorts it. One statement. */
async function plannedSessionsOf(db: Db, userId: string, planId: string, course: string, today: string) {
  const ref = sql<string | null>`case when json_valid(${pw.workoutDoc}) then json_extract(${pw.workoutDoc}, '$.source.ref') end`;
  const prefix = `${course}-course:`;
  const rows = await db
    .select({
      id: pw.id,
      date: pw.effectiveDate,
      completion: pw.completionState,
      content: pw.contentState,
      rev: pw.workoutDocRev,
      ref,
      // Raw names: Drizzle strips a column's table inside a single table's select, and `"id"` would be the subquery's own.
      performed: sql<number>`exists (select 1 from performed_sessions s where s.workout_id = planned_workouts.id)`,
    })
    .from(pw)
    .where(and(eq(pw.userId, userId), ne(pw.planId, planId), isNull(pw.archivedAt), inArray(pw.origin, [...DOC_ORIGINS]), sql`substr(${ref}, 1, ${prefix.length}) = ${prefix}`));
  const sessions = rows.filter((r) => courseSessionOfRef(course, r.ref) !== null);
  const ahead = (r: (typeof rows)[number]) => r.date >= today;
  const kept = (r: (typeof rows)[number]) => (FROZEN_STATES as readonly string[]).includes(r.completion) || (r.rev ?? 0) > 1;
  return {
    takenIn: sessions.filter((r) => underWay(r) || (ahead(r) && kept(r))),
    comingOff: sessions.filter((r) => !underWay(r) && ahead(r) && !kept(r)).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
  };
}

/** Move these to the plan with the number their `source.ref` holds, and nothing else: no revision, no mark for the watch. */
function takeIn(db: Db, userId: string, planId: string, course: string, ids: readonly string[], now: string) {
  const from = `${course}-course:`.length + 1;
  return chunkIds([...ids]).map((chunk) =>
    db
      .update(pw)
      .set({ planId, courseSession: sql`cast(substr(json_extract(${pw.workoutDoc}, '$.source.ref'), ${from}) as integer)`, updatedAt: now })
      .where(and(eq(pw.userId, userId), inArray(pw.id, chunk), isNull(pw.archivedAt))),
  );
}

export type CourseStartResult =
  | { ok: true; planId: string; more: boolean }
  | { ok: false; error: "unknown_course" | "restore_in_progress" };

/**
 * The header's start, as far as `budget` goes: statements for everything past the fixed ones the route sets aside
 * (`COURSE_START_FIXED`). Throws `RestoreInProgressError` when a restore begins part way.
 */
export async function startCourse(
  db: Db,
  userId: string,
  input: { course: string; weekdays: number[]; time: string },
  ctx: PlanCtx,
  budget: number,
): Promise<CourseStartResult> {
  if (!courseDefinition(input.course)) return { ok: false, error: "unknown_course" };
  if (await restoreInProgress(db, userId)) return { ok: false, error: "restore_in_progress" };
  const { today, now, prefs } = ctx;
  const planId = await theCoursePlan(db, userId, input, now);
  const { takenIn, comingOff } = await plannedSessionsOf(db, userId, planId, input.course, today);
  const moves = takeIn(db, userId, planId, input.course, takenIn.map((r) => r.id), now);
  for (const move of moves) await move;

  // The fixed statements allow for one statement of moves.
  let room = budget - Math.max(0, moves.length - 1);
  let left = false;
  for (const [i, r] of comingOff.entries()) {
    if (i > 0 && RETRACT_WRITTEN_COST > room) {
      left = true;
      break;
    }
    room -= RETRACT_WRITTEN_COST;
    try {
      await removeDocWorkout(db, userId, r.id, { today, now, prefs }, BY_THE_PLAN);
    } catch (e) {
      if (e instanceof DocWorkoutNotFoundError) continue;
      if (!(e instanceof NotRemovableError)) throw e;
      // Begun, saved or on the wire since the read: the next send sorts it again.
      left = true;
    }
  }
  if (left || room < RUNNING_PASS_MIN) return { ok: true, planId, more: true };
  return { ok: true, planId, more: (await placeSlotsWithin(db, userId, planId, today, prefs, now, room)).more };
}

/**
 * The header's stop, as far as `budget` goes: statements for everything past the fixed ones the route sets aside
 * (`PLAN_STOP_FIXED`). `program`: the plan, read by the caller. Throws `RestoreInProgressError` when a restore begins part way.
 */
export async function stopCourse(db: Db, userId: string, program: ProgramRow, ctx: PlanCtx, budget: number): Promise<{ more: boolean }> {
  const { today, now, prefs } = ctx;
  if (program.status !== "retired") {
    await db
      .update(programs)
      .set({ status: "retired", updatedAt: now })
      .where(and(eq(programs.id, program.id), eq(programs.userId, userId)));
  }
  const rows = await db
    .select({ id: pw.id, origin: pw.origin })
    .from(pw)
    .where(
      and(
        eq(pw.userId, userId),
        eq(pw.planId, program.id),
        isNull(pw.archivedAt),
        gte(pw.effectiveDate, today),
        inArray(pw.completionState, [...STILL_TO_DO]),
        or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
        sql`not exists (select 1 from ${performedSessions} where ${performedSessions.workoutId} = ${pw.id})`,
      ),
    )
    .orderBy(asc(pw.effectiveDate), asc(pw.id));

  let room = budget;
  let more = false;
  const documents = rows.filter((r) => docOriginRow(r));
  for (const [i, r] of documents.entries()) {
    if (i > 0 && RETRACT_WRITTEN_COST > room) return { more: true };
    room -= RETRACT_WRITTEN_COST;
    try {
      await removeDocWorkout(db, userId, r.id, { today, now, prefs }, BY_THE_PLAN);
    } catch (e) {
      if (e instanceof DocWorkoutNotFoundError) continue;
      if (!(e instanceof NotRemovableError)) throw e;
      // On the wire: it can come off once it lands. Begun or saved since the read: it stays, and the next read says so.
      if (e.reason === "sending") more = true;
    }
  }

  const outlines = rows.filter((r) => !docOriginRow(r));
  if (outlines.length === 0) return { more };
  if (room < STOPPED_PASS_MIN) return { more: true };
  const placed = await placeSlotsWithin(db, userId, program.id, today, prefs, now, room);
  room -= placed.spent;
  if (placed.more) return { more: true };

  const gone = new Set(placed.archived);
  const fixed = outlines.filter((r) => !gone.has(r.id));
  if (fixed.length === 0) return { more };
  // Looked at again: the pass ran a good while, and these are writes it didn't make.
  room -= 1;
  if (await restoreInProgress(db, userId)) return { more: true };
  for (const r of fixed) {
    if (RETRACT_COST > room) return { more: true };
    room -= RETRACT_COST;
    // Only while it is still as read: a session begun or saved since keeps its row.
    await removeFromPlan(db, userId, r.id, {
      now,
      prefs,
      ...BY_THE_PLAN,
      onlyIf: and(
        inArray(pw.completionState, [...STILL_TO_DO]),
        or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
        sql`not exists (select 1 from ${performedSessions} where ${performedSessions.workoutId} = ${r.id})`,
      ),
    });
  }
  return { more };
}
