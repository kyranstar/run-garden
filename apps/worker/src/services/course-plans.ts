/**
 * STARTING AND STOPPING A COURSE (plans with a purpose, spec §4.2, rulings R28, R29, R33 to R37). Nothing here names a course:
 * all of it reads `CourseDefinition`.
 *
 * ONE PLAN PER COURSE, ALWAYS. A start finds the plan by the course its settings name, whatever its id. Stopped, that same row
 * comes back with the days and the time asked for now, so its number goes on from the sessions done, the ones completed
 * without being written (a number and no document) among them. A revival keeps the plan's own words and any easing asked for,
 * a pause from before the stop doesn't outlive it, and it writes a `program_versions` row saying what changed. A new plan
 * takes an id from the account and the course, so two racing first starts make one row. Running, it stands as it is: other
 * days or another time are refused (`course_running`), since answering 200 and ignoring them would be false.
 *
 * WHAT'S ALREADY PLANNED (`finishStart`). Sessions from before courses existed sit in the Studio's bucket as document workouts.
 * One is a session of this course when its document's `source.ref` says `<course>-course:<n>`. Each comes to one of:
 *  - TAKEN IN: it moves to the plan with `course_session` = n and nothing else changes, so there's no new revision and nothing
 *    goes to the watch. That's everything behind today, whatever its state: only a completed one counts, and one still
 *    unresolved has to be in the plan when it's finished or that session repeats. It's also one under way, whenever it was: the
 *    code's own meaning (`LOCKED_CONTENT`, what `revisability` calls under way and `removeDocWorkout` won't take), content
 *    started or done, or a performed session saved against it. Built isn't under way. And today or ahead, one revised after it
 *    was planned, since removing it would lose the athlete's edit, and one skipped, whose day the athlete has already spoken for
 *    and which a removal can't take. Either holds its day and counts toward its week as any of the course's own does.
 *  - AHEAD: today or later and none of the above. It comes off through `removeDocWorkout`, a copy on the watch with it, so
 *    the course's own outline can take over.
 * Placement runs once none is left ahead. Not before: an outline beside the session it replaces would be two on one day.
 *
 * STOPPING (`stopCourse`, `finishStop`). The status goes first, so nothing is written for the plan from then on (the write's
 * guard holds to it). Then every session of the plan today or ahead comes off, its own or filed by the coach, unless it has
 * started or been saved. A revised one comes off too: unlike a pause, a stop is the athlete ending it, and nothing comes back to
 * overwrite the edit. What's behind stays, and so does what's already resolved. They go in this order, since a request may not
 * fit them all: documents first, soonest first, through `removeDocWorkout`; then the flexible outlines through placement's goal
 * 0 pass (`placeSlotsWithin`), the same pass a programme's retirement runs; then the outlines that pass rightly leaves for a
 * plan that's merely changing its days, today's and any moved or re-timed.
 *
 * WHY `program_replaced` (`BY_THE_PLAN`). Everything a stop or a start takes off is archived for that reason. It's the
 * plan's doing, not the athlete's, so a restart can bring the same row back on its day: a day whose slot says `user_removed`
 * is the athlete's and stays empty for good (`program-slots.ts`, rule 1).
 *
 * RESUMABLE WORK (R33). A request does what fits, and an app closed part way mustn't double days or leave live sessions under a
 * stopped plan. So `config.finishing` ("start" or "stop") is set by the first send's own write and cleared by the write that
 * finds nothing left. While it's "start" the plan's fill holds (`placementOf`), and either way the hourly pass runs the very
 * step a request runs (`finishCoursesPartWay`, `COURSE_FINISH_BUDGET`). Nothing else is stored: each step reads what's still
 * there. Once cleared, a retry changes nothing: a stop reads nothing more, and a start only runs the pass, as the hourly does, so
 * a Studio session with that ref added since stays where it was put. Stopping a start part way leaves what it hadn't reached in
 * the bucket: those were never the plan's.
 *
 * WHAT THE ANSWER SAYS. `more`: something's left. `waiting` as well: all that's left is a day's build on the wire this moment
 * (`NotRemovableError`'s `sending`), so a resend can't help; the client stops, and the hourly pass takes it once it lands. A row
 * on the wire holds up nothing behind it, as it spends only its reads (`RETRACT_WRITTEN_READS`).
 *
 * A restore in progress: `restore_in_progress` before anything is written, or `RestoreInProgressError` from a removal once a
 * restore has begun part way. The hourly pass skips such an account, and that isn't a failure.
 */
import { and, asc, eq, gte, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { performedSessions, plannedWorkouts, programs, userPreferences } from "@rg/database";
import { courseConfigSchema, defaultOnEnd, DOC_ORIGINS, docOriginRow, nowInstant, todayInZone, userPreferencesSchema, type UserPreferences } from "@rg/domain";
import { courseDefinition, courseSessionOfRef } from "@rg/workout";
import { restoreInProgress } from "./account-state.js";
import { STILL_TO_DO } from "./course-sessions.js";
import { COURSE_FINISH_BUDGET, COURSE_FINISHES_PER_PASS } from "./cron-limits.js";
import { chunkIds, runAtomically, type Db } from "./db.js";
import { DocWorkoutNotFoundError, LOCKED_CONTENT, NotRemovableError, removeDocWorkout } from "./doc-workouts.js";
import { removeFromPlan } from "./plan-mutations.js";
import { planVersionInsert } from "./plan-registry.js";
import { placeSlotsWithin, RETRACT_COST, RETRACT_WRITTEN_COST, RETRACT_WRITTEN_READS, RUNNING_PASS_MIN, STOPPED_PASS_MIN } from "./program-slots.js";
import { RestoreInProgressError } from "./programs.js";
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

/** Where a step left things (the header's WHAT THE ANSWER SAYS). */
export interface CourseStep {
  more: boolean;
  waiting?: true;
}

/** The same days at the same time: a retry of what's running, in whatever order it names them. */
const sameSchedule = (a: { weekdays: readonly number[]; time: string }, b: { weekdays: readonly number[]; time: string }): boolean =>
  a.time === b.time && a.weekdays.length === b.weekdays.length && a.weekdays.every((d) => b.weekdays.includes(d));

/** Clear the marker: its step found nothing left. Only that kind's, so an older step can't clear a newer one's. */
const clearFinishing = (db: Db, userId: string, planId: string, kind: "start" | "stop", now: string) =>
  db
    .update(programs)
    .set({ config: sql`json_remove(${programs.config}, '$.finishing')`, updatedAt: now })
    .where(and(eq(programs.id, planId), eq(programs.userId, userId), sql`json_extract(${programs.config}, '$.finishing') = ${kind}`));

/** What a new plan of a course is called by: one per account per course. */
const coursePlanId = (userId: string, course: string): string => `course-${userId}-${course}`;

/**
 * The course's one plan, running: found and left as it is, revived, or made (the header's ONE PLAN PER COURSE); null when it's
 * running on other days. `starting`: its start isn't finished, so the step goes on. At most four statements.
 */
async function theCoursePlan(db: Db, userId: string, input: { course: string; weekdays: number[]; time: string }, now: string): Promise<{ id: string; starting: boolean } | null> {
  const [found] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.kind, "course"), sql`json_extract(${programs.config}, '$.course') = ${input.course}`))
    .limit(1);
  const asked = { course: input.course, weekdays: input.weekdays, time: input.time };
  if (found) {
    const stored = courseConfigSchema.safeParse(found.config);
    if (found.status === "active" && found.archivedAt === null && stored.success) {
      return sameSchedule(stored.data, asked) ? { id: found.id, starting: stored.data.finishing === "start" } : null;
    }
    const config = courseConfigSchema.parse({ ...(stored.success ? stored.data : {}), ...asked, finishing: "start" });
    const changed = [
      ...(found.status !== "active" ? ["status"] : []),
      ...(found.archivedAt !== null ? ["archivedAt"] : []),
      ...(!stored.success || JSON.stringify(stored.data.weekdays) !== JSON.stringify(asked.weekdays) ? ["weekdays"] : []),
      ...(!stored.success || stored.data.time !== asked.time ? ["time"] : []),
      ...(found.pausedUntil !== null ? ["pausedUntil"] : []),
    ];
    const fields = { purpose: found.purpose, brief: found.brief, onEnd: found.onEnd, pausedUntil: null, objectiveIds: found.objectiveIds, config };
    await runAtomically(db, [
      db
        .update(programs)
        .set({ status: "active", archivedAt: null, pausedUntil: null, config, updatedAt: now })
        .where(and(eq(programs.id, found.id), eq(programs.userId, userId))),
      (await planVersionInsert(db, found.id, fields, changed, now)).insert,
    ]);
    return { id: found.id, starting: true };
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
      config: courseConfigSchema.parse({ ...asked, finishing: "start" }),
      purpose: definition.purpose,
      brief: definition.brief,
      onEnd: defaultOnEnd("course", disciplines),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .onConflictDoNothing();
  return { id, starting: true };
}

/** A session is under way, or done: `LOCKED_CONTENT`, or a performed session saved against it. */
const underWay = (r: { content: string | null; performed: unknown }): boolean => (LOCKED_CONTENT as readonly (string | null)[]).includes(r.content) || Boolean(r.performed);

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
  const comesOff = (r: (typeof rows)[number]) => r.date >= today && !underWay(r) && !(FROZEN_STATES as readonly string[]).includes(r.completion) && (r.rev ?? 0) <= 1;
  return {
    takenIn: sessions.filter((r) => !comesOff(r)),
    comingOff: sessions.filter(comesOff).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
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

/**
 * Take these off in turn, as many as `room` holds, the first whatever it costs. One on the wire, or begun since the read, spends
 * only its reads, so it holds up nothing behind it. `unreached`: room ran out. `raced`: begun or saved since the read.
 */
async function removeInTurn(db: Db, userId: string, rows: ReadonlyArray<{ id: string }>, { today, now, prefs }: PlanCtx, room: number) {
  const out = { room, unreached: false, raced: false, sending: 0 };
  for (const [i, r] of rows.entries()) {
    if (i > 0 && RETRACT_WRITTEN_COST > out.room) {
      out.unreached = true;
      break;
    }
    try {
      await removeDocWorkout(db, userId, r.id, { today, now, prefs }, BY_THE_PLAN);
      out.room -= RETRACT_WRITTEN_COST;
    } catch (e) {
      out.room -= RETRACT_WRITTEN_READS;
      if (e instanceof DocWorkoutNotFoundError) continue;
      if (!(e instanceof NotRemovableError)) throw e;
      if (e.reason === "sending") out.sending += 1;
      else out.raced = true;
    }
  }
  return out;
}

/**
 * THE START'S STEP (the header's WHAT'S ALREADY PLANNED and RESUMABLE WORK), a request's and the hourly pass's: within `budget`
 * statements, its read, one statement of moves and the marker's clear among them. Throws `RestoreInProgressError`.
 */
async function finishStart(db: Db, userId: string, planId: string, course: string, ctx: PlanCtx, budget: number): Promise<CourseStep> {
  const { today, now, prefs } = ctx;
  const { takenIn, comingOff } = await plannedSessionsOf(db, userId, planId, course, today);
  const moves = takeIn(db, userId, planId, course, takenIn.map((r) => r.id), now);
  for (const move of moves) await move;
  const removed = await removeInTurn(db, userId, comingOff, ctx, budget - 3 - Math.max(0, moves.length - 1));
  // Begun or saved since the read: the next step takes it in. Room ran out: the next step goes on.
  if (removed.unreached || removed.raced) return { more: true };
  if (removed.sending > 0) return { more: true, waiting: true };
  await clearFinishing(db, userId, planId, "start", now);
  // The retry's pass, or the hour's, fills what doesn't fit here.
  if (removed.room < RUNNING_PASS_MIN) return { more: true };
  return { more: (await placeSlotsWithin(db, userId, planId, today, prefs, now, removed.room)).more };
}

export type CourseStartResult =
  | ({ ok: true; planId: string } & CourseStep)
  | { ok: false; error: "unknown_course" | "restore_in_progress" | "course_running" };

/**
 * The header's start: the plan, then its step, or, with its start finished, the pass alone. `budget`: statements past the fixed
 * ones the route sets aside (`COURSE_START_FIXED`). Throws `RestoreInProgressError` when a restore begins part way.
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
  const plan = await theCoursePlan(db, userId, input, ctx.now);
  if (!plan) return { ok: false, error: "course_running" };
  if (plan.starting) return { ok: true, planId: plan.id, ...(await finishStart(db, userId, plan.id, input.course, ctx, budget)) };
  return { ok: true, planId: plan.id, more: (await placeSlotsWithin(db, userId, plan.id, ctx.today, ctx.prefs, ctx.now, budget)).more };
}

/**
 * THE STOP'S STEP (the header's STOPPING and RESUMABLE WORK), a request's and the hourly pass's: within `budget` statements, its
 * read and the marker's clear among them. Throws `RestoreInProgressError`.
 */
async function finishStop(db: Db, userId: string, planId: string, ctx: PlanCtx, budget: number): Promise<CourseStep> {
  const { today, now, prefs } = ctx;
  const rows = await db
    .select({ id: pw.id, origin: pw.origin })
    .from(pw)
    .where(
      and(
        eq(pw.userId, userId),
        eq(pw.planId, planId),
        isNull(pw.archivedAt),
        gte(pw.effectiveDate, today),
        inArray(pw.completionState, [...STILL_TO_DO]),
        or(isNull(pw.contentState), notInArray(pw.contentState, [...LOCKED_CONTENT])),
        sql`not exists (select 1 from ${performedSessions} where ${performedSessions.workoutId} = ${pw.id})`,
      ),
    )
    .orderBy(asc(pw.effectiveDate), asc(pw.id));

  const removed = await removeInTurn(db, userId, rows.filter((r) => docOriginRow(r)), ctx, budget - 2);
  if (removed.unreached) return { more: true };
  let room = removed.room;

  const outlines = rows.filter((r) => !docOriginRow(r));
  if (outlines.length > 0) {
    if (room < STOPPED_PASS_MIN) return { more: true };
    const placed = await placeSlotsWithin(db, userId, planId, today, prefs, now, room);
    room -= placed.spent;
    if (placed.more) return { more: true };

    const gone = new Set(placed.archived);
    const fixed = outlines.filter((r) => !gone.has(r.id));
    if (fixed.length > 0) {
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
    }
  }
  if (removed.sending > 0) return { more: true, waiting: true };
  await clearFinishing(db, userId, planId, "stop", now);
  return { more: false };
}

/**
 * The header's stop: the status and the marker with the first send, then the step. A plan already stopped and finished changes
 * nothing. `program`: the plan, read by the caller. `budget`: statements past the fixed ones the route sets aside
 * (`PLAN_STOP_FIXED`). Throws `RestoreInProgressError` when a restore begins part way.
 */
export async function stopCourse(db: Db, userId: string, program: ProgramRow, ctx: PlanCtx, budget: number): Promise<CourseStep> {
  if (program.status === "retired" && (program.config as { finishing?: unknown }).finishing !== "stop") return { more: false };
  if (program.status !== "retired") {
    await db
      .update(programs)
      .set({ status: "retired", config: sql`json_set(${programs.config}, '$.finishing', 'stop')`, updatedAt: ctx.now })
      .where(and(eq(programs.id, program.id), eq(programs.userId, userId)));
  }
  return finishStop(db, userId, program.id, ctx, budget);
}

/**
 * THE HOURLY PASS (the header's RESUMABLE WORK): the courses part way through a start or a stop, each in its athlete's zone and
 * by the very step a request runs, at most `COURSE_FINISHES_PER_PASS` of them, picked at random so one still waiting holds no
 * other up. One read when none is part way; an account a restore is replacing writes nothing; one failing doesn't stop the rest.
 */
export async function finishCoursesPartWay(db: Db, at: Date = new Date()): Promise<{ finished: number; failed: number }> {
  const stats = { finished: 0, failed: 0 };
  const rows = await db
    .select({ program: programs, prefs: userPreferences.prefs })
    .from(programs)
    .leftJoin(userPreferences, eq(userPreferences.userId, programs.userId))
    .where(and(eq(programs.kind, "course"), sql`case when json_valid(${programs.config}) then json_extract(${programs.config}, '$.finishing') end is not null`))
    .orderBy(sql`random()`)
    .limit(COURSE_FINISHES_PER_PASS);
  const now = nowInstant(at);
  for (const { program, prefs: stored } of rows) {
    try {
      if (await restoreInProgress(db, program.userId)) continue;
      const prefs = userPreferencesSchema.parse(stored ?? {});
      const ctx = { today: todayInZone(prefs.timezone, at), now, prefs };
      const config = courseConfigSchema.parse(program.config);
      if (config.finishing === "start") await finishStart(db, program.userId, program.id, config.course, ctx, COURSE_FINISH_BUDGET);
      else await finishStop(db, program.userId, program.id, ctx, COURSE_FINISH_BUDGET);
      stats.finished += 1;
    } catch (e) {
      if (e instanceof RestoreInProgressError) continue;
      stats.failed += 1;
      console.error(`course finish failed for program ${program.id}: ${e instanceof Error ? e.name : "unknown"}`);
    }
  }
  return stats;
}
