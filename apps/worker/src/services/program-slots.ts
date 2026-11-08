/**
 * A PROGRAM'S SLOTS, ADAPTIVE OR A COURSE — where its sessions sit on the calendar (Phase 2 spec §2a "Slot placement",
 * programme spec §9.1; a course: plans with a purpose, spec §4.2).
 *
 * A slot is a planned row like any other (`origin = 'program'`, `content_state = 'outline'`,
 * `coros_sync_state = 'calendar_only'`): the calendar reconciler books it, the athlete moves, skips and removes it
 * with the existing verbs, and its content is built on its day (`session-build.ts`). This file only decides
 * WHICH DAYS hold one.
 *
 * THE RULE, per ISO week from this one to `placementWeeksAhead` weeks ahead:
 *
 *  1. COUNT BY THE DAY A SLOT WAS PLANNED ON (`original_plan_date`), whatever has happened to it since. A slot the
 *     athlete moved to next week still counts for this one; skipped, done and removed slots count. That is what
 *     makes placement safe to run every hour: anything the athlete did to a slot is never undone or re-placed.
 *     The one exception is a slot this file retracted itself (`program_replaced`): it is not the athlete's, and
 *     a later edit that wants that day again brings the same row back.
 *  2. THE WEEK'S GOAL goes on `preferredDays` in order, then the week's other days Monday → Sunday, never before
 *     today, one slot of this program per date. Two limits on a NEW slot (ruling 2a-R11): none on today once
 *     today's window has passed in the athlete's zone, and in THIS week only on the days a full week would use
 *     (the first `weeklyGoal` of that order) — a mid-week start or a raised goal never crams the week. Never on race
 *     day (`prefs.raceDate`): a flexible slot placed there before the race was set moves to the week's next day.
 *  3. ONLY FLEXIBLE SLOTS MAY GO: a slot that is live, still an outline, still a slot (`origin = 'program'`), unmoved
 *     (effective date = planned date), still scheduled, and after today, or today itself while a pause covers it (rule
 *     6). Everything else — today's otherwise, a moved one, a built or started one, a past one, a course's written one —
 *     is fixed: it counts toward the goal and stays. Flexible slots on wanted days stay too, so a settled week writes
 *     nothing at all.
 *  4. Flexible slots the pattern no longer wants (goal lowered, a day dropped, the program retired) are archived
 *     through `removeFromPlan` — `archive_reason = 'program_replaced'` and the one `user_removed` calendar
 *     suppression a hand removal gets — and only then are missing days filled.
 *  5. A SLOT SAYS WHAT ITS PROGRAM SAYS NOW: a rename, a new length or a new lead discipline reaches the program's
 *     live slots from today on (`refreshSlotContent`); history keeps what it said.
 *  6. A DAY HELD BACK IS PASSED OVER, and a flexible slot on it goes as in rule 4: any day up to and including the
 *     program's `paused_until` (spec §4.4, either kind; it ends by itself on its date), and a course's quiet days, from
 *     `quietDaysBeforeRace` before `prefs.raceDate` through race day. A week a pause reaches holds only the days a full
 *     week would use, as this week does, so nothing piles up behind it. A pause also takes today's untouched outline,
 *     since someone pausing for illness doesn't want it waiting; a built, started or touched one stays, and the quiet
 *     days leave today's alone. So does it take a course's session written today and not yet touched, built, started or
 *     done, or it would stay on the plan and read as missed: the hourly pass writes one soon after midnight, so a pause
 *     rarely finds an outline. It leaves through the document removal path (`removeDocWorkout`), so its copy comes off the
 *     watch too, and its number isn't counted, so the same session comes back after the pause. One the athlete or the coach
 *     has revised since stays (`TOUCHED`): a pause never discards an edit. With no pause an adaptive program holds no day
 *     back. A change to a pause takes effect in its own request (`placeAfterPauseChange`), within the request's budget:
 *     today's go first, and what doesn't fit goes with the next hourly pass.
 *
 * A COURSE places by the same rules, from `placementOf`. Its `weekdays` are its preferred days and its weekly goal, and
 * its only days: it never falls back on the week's others. Its slots go at its `time`, not the athlete's window. Their
 * length is the next session's (`sessionDoc(done + 1)`, numbered from the sessions actually done), booked as that
 * session's write will book it, so nothing shifts on the day. They hold no document, so nothing goes to the watch. A
 * course kept off the watch (`CourseDefinition.watch === false`, the flag and nothing else) places each outline with the
 * row's own Keep off my watch set (`watch_off`), in its insert, so every session ahead reads kept off and offers Put on;
 * its day's write leaves the row's choice as it stands (`course-sessions.ts`). A revived outline keeps what it had: the
 * course's own from its placing, or the athlete's Put on or Keep off since. Every other kind places them on. A
 * stopped course only retracts, which needs no definition; what rule 3 keeps from this pass, a stop takes itself
 * (`course-plans.ts`). A start part way (`config.finishing`) holds its whole pass: placed now, an outline would land beside a
 * session the start hasn't taken off yet.
 *
 * Its `time` isn't pinned, on purpose: on a day that really collides, the collision pass re-lays it with the day's other
 * sessions (`separateDayCollisions`), because a double-booked evening is worse than a moved outline. A time the athlete
 * pins on a session after it's written is unaffected.
 *
 * A course's own sessions are its slots (`origin = 'program'`) and the rows with `course_session` set, the session number
 * a row was written as. On its day a session is written (`course-sessions.ts`): the row keeps its id, flips to
 * `origin = 'studio'` and takes its number, as a session re-pointed to the course does. A pass reads them, so each counts
 * toward its week and holds its day, and rule 5 never touches them. `source_content_fingerprint` can't mark them, because a verified push overwrites it. A
 * document workout's `content_state` is 'outline' too, so its origin is what says it isn't a slot any more. A workout the
 * coach filed under the plan is neither: it counts toward no week, no slot makes way for it, and it isn't a session done.
 *
 * Every writer here is a no-op while a restore is replacing the account (ruling B2).
 *
 * A REQUEST PLACES WITHIN ITS BUDGET (`placeSlotsWithin`, 2026-10-19): a change of days retracts every flexible slot
 * the new pattern drops, about eight statements each, so one settings save at four weeks ahead measured 123 against the
 * free plan's 50 an invocation. A request's pass declares what each step costs, does what fits — the retractions first,
 * then the new slots, the revived ones and the refreshed ones, each with its day's collision pass — and says `more`
 * when something is left; the next request (or the hourly pass, which has no budget) carries on from the rows, since
 * placement re-derives everything each time.
 */
import { and, count, eq, gt, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql } from "drizzle-orm";
import { calendarEventSuppressions, plannedWorkouts, programs, scheduleOverrides, sessionBuilds } from "@rg/database";
import { adaptiveConfigSchema, addDays, courseConfigSchema, nowInstant, startOfIsoWeek, todayInZone, type AdaptiveConfig, type UserPreferences } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { courseDefinition, deriveDoc } from "@rg/workout";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkedInsert, chunkIds, insertBatches, type Db } from "./db.js";
import { DocWorkoutNotFoundError, NotRemovableError, removeDocWorkout } from "./doc-workouts.js";
import { plannedRowColumns, type PlannedRow } from "./planned-columns.js";
import { separateDayCollisions, windowTimeFor } from "./day-placement.js";
import { removeFromPlan } from "./plan-mutations.js";
import { RestoreInProgressError } from "./programs.js";
import { isRuntimeLimit } from "./runtime-limit.js";
import { bookedSeconds } from "./session-build.js";

/** A planned row without its workout document: placement never reads one. */
type WorkoutRow = PlannedRow;
type ProgramRow = typeof programs.$inferSelect;

/** The kinds whose slots this file places. */
const PLACED_KINDS = ["adaptive", "course"];

/** The days a pass fills, in an adaptive program's terms (a course's are put in them by `placementOf`). */
type SlotPattern = Pick<AdaptiveConfig, "weeklyGoal" | "preferredDays" | "placementWeeksAhead">;

/** What a pass places from, whichever kind makes the sessions (`placementOf`). */
interface Placement {
  config: SlotPattern;
  /** Sessions a week; 0 when it wants no slots. */
  goal: number;
  /** What its outlines say they take, and what the calendar books for that; null = a stopped course, which only retracts. */
  length: { seconds: number; booked: number } | null;
  title: string;
  /** The time its slots go at; null = the athlete's window for the day (`windowTimeFor`). */
  time: string | null;
  /** The days before the race it places nothing on; null = only race day is kept clear. */
  quietDays: number | null;
  /** Its days are its only days, and its own sessions still hold theirs once written (`course_session`). */
  isCourse: boolean;
  /** Its new outlines are placed kept off the watch (`watch_off`): a course whose definition says `watch: false`. */
  watchOff: boolean;
}

export interface PlacementResult {
  /** Slots put on the calendar: new rows, and retracted ones brought back. */
  placed: string[];
  /** Slots retracted (`program_replaced`). */
  archived: string[];
}

/** A pass within a budget (`placeSlotsWithin`). */
export interface BudgetedPlacement extends PlacementResult {
  /** Something is left for the next pass: a retraction, or a slot to place or refresh. */
  more: boolean;
  /** The statements this pass declared — an upper bound on what it ran. */
  spent: number;
}

/**
 * One retraction (`retractSlot` → `removeFromPlan`) at its most, for a slot that is an outline — the only kind it
 * archives: the row read and archived (2), its queued watch writes settled (1), its calendar suppression (1), its intent
 * (2), an open move intent read and closed (2), and its sent build looked for (2; an outline was never sent, so no unpush
 * follows — a slot's own id is never a watch address). Measured 8 (programs-budget.test.ts).
 */
export const RETRACT_COST = 2 + 1 + 1 + 2 + 2 + 2;
/**
 * One written session's retraction at its most (`retractWritten` → `removeDocWorkout`): its reads before the removal (the row,
 * a saved session, its sent build found (two) and its push, the restore's look: 6), the retraction above without its look
 * for a sent build (8), and a copy on the watch to take off (`SKIP_UNPUSH_COST`'s 8). Pinned in course-sessions.test.ts.
 */
export const RETRACT_WRITTEN_READS = 6;
export const RETRACT_WRITTEN_COST = RETRACT_WRITTEN_READS + 8 + 8;
/**
 * What a pass that takes today's written session declares at its most (`placeSlotsWithin`): the restore's look, the plan, the
 * sessions done, the rows, the touched lookup and the restore's look again (6), the removal, and rule 5's read. Pinned in
 * course-sessions.test.ts. What a request sets aside for a pause, beside whatever else it does.
 */
export const PAUSE_PASS_COST = 6 + RETRACT_WRITTEN_COST + 1;
/**
 * The least a budgeted pass should be handed, since its first step runs whatever it costs: its reads and its look before
 * writing, and one retraction (course-placement.test.ts, programs-budget.test.ts). A running course reads its sessions done as
 * well. A first new slot costs no more than a retraction on a day that holds few sessions.
 */
export const STOPPED_PASS_MIN = 5 + RETRACT_COST;
export const RUNNING_PASS_MIN = 6 + RETRACT_COST;
/** A retracted slot brought back: its row, its suppression and its overrides. Measured in course-start.test.ts. */
export const REVIVE_COST = 3;
/** The ids one touched lookup, and one build lookup, bind (`TOUCHED_ID_CHUNK`, `BUILD_ID_CHUNK`). */
const ID_CHUNK = 80;

/** A slot's id: one per program per planned date, so placement can never duplicate one. */
export function slotId(programId: string, date: string): string {
  return `slot-${programId}-${date}`;
}

/**
 * The discipline a slot carries before it is built (programme spec §9.2): the build sets `strength` when the
 * session holds a core lift and `yoga` otherwise; until then, the program's first listed discipline when that is
 * strength, else yoga.
 */
export function defaultDiscipline(program: Pick<ProgramRow, "disciplines">): "strength" | "yoga" {
  return program.disciplines[0] === "strength" ? "strength" : "yoga";
}

/** A slot this file itself retracted — not something the athlete did, so it does not hold its week's place. */
function retracted(r: WorkoutRow): boolean {
  return r.archivedAt !== null && r.archiveReason === "program_replaced";
}

/** Whether a plan's pause (`programs.paused_until`, its last day) covers this date. */
export const pausedOn = (pausedUntil: string | null, date: string): boolean => pausedUntil !== null && date <= pausedUntil;

/**
 * Rule 3, as the row reads: the only slots an edit may take away — unless the athlete touched them (`TOUCHED`). `todayToo`:
 * a pause covers today, so today's may go as well.
 */
function flexible(r: WorkoutRow, today: string, todayToo: boolean): boolean {
  return (
    r.archivedAt === null &&
    r.origin === "program" &&
    r.completionState === "scheduled" &&
    r.contentState === "outline" &&
    r.effectiveDate === r.originalPlanDate &&
    (todayToo ? r.effectiveDate >= today : r.effectiveDate > today)
  );
}

/** Among a pass's rows, a course's own session once written (`readSlotRows` reads no other row that isn't a slot). */
const writtenSession = (r: Pick<WorkoutRow, "origin">): boolean => r.origin !== "program";

/**
 * Rule 6's written session, as the row reads: today's, its own day, and neither built, started nor resolved. A slot like that
 * is rule 3's under a pause anyway, so this needn't tell them apart. `todayToo`: a pause covers today.
 */
function writtenOffToday(r: WorkoutRow, today: string, todayToo: boolean): boolean {
  return (
    todayToo &&
    r.archivedAt === null &&
    r.completionState === "scheduled" &&
    r.contentState === "outline" &&
    r.effectiveDate === today &&
    r.originalPlanDate === today
  );
}

/**
 * Rule 3's other half (ruling 2a-R12): a slot the athlete TOUCHED is fixed, whatever its dates say — it has a
 * schedule override of any kind (re-timed on its own day, moved away and back), or a preview build carrying their
 * overrides or swaps (a sheet customised ahead of the day). So is a course's written session someone revised since: its
 * latest revision is anyone's but the write's own (`studio`), the athlete's or the coach's. By who made it, never by its
 * number: a session written again after a same-day lift is the course's own at revision 2. Only while it holds a document: a
 * session that came off and came back as an outline keeps its revision counter, and that history is no touch of the outline's.
 * Raw SQL over `planned_workouts.id`, so it reads the same inside the SELECT that plans and inside the archive's UPDATE.
 */
const TOUCHED = sql.raw(
  "(exists (select 1 from schedule_overrides so where so.workout_id = planned_workouts.id)" +
    " or exists (select 1 from session_builds sb where sb.workout_id = planned_workouts.id and sb.version = 0" +
    " and (coalesce(json_extract(sb.payload, '$.build.params.overrides'), '{}') <> '{}'" +
    " or coalesce(json_extract(sb.payload, '$.build.params.swaps'), '{}') <> '{}'))" +
    " or exists (select 1 from workout_doc_revisions r where planned_workouts.workout_doc is not null and r.id = planned_workouts.id || ':' || planned_workouts.workout_doc_rev and r.source_kind <> 'studio'))",
);

/** Bound per statement for the touched lookup: the ids, nothing else. */
const TOUCHED_ID_CHUNK = ID_CHUNK;

/** Which of these slots the athlete touched (`TOUCHED`). */
async function touchedSlots(db: Db, ids: readonly string[]): Promise<Set<string>> {
  const touched = new Set<string>();
  for (const batch of chunkIds([...ids], TOUCHED_ID_CHUNK)) {
    const rows = await db
      .select({ id: plannedWorkouts.id })
      .from(plannedWorkouts)
      .where(and(inArray(plannedWorkouts.id, batch), TOUCHED));
    for (const r of rows) touched.add(r.id);
  }
  return touched;
}

/**
 * Rule 4's retraction of one slot, re-checked AS IT ARCHIVES (audit 2a-model M4): the archive's UPDATE carries
 * rule 3 whole — live, outline, still a slot, scheduled, unmoved, after today, untouched — so an athlete's move,
 * re-time, skip or build, or a course session's write, landing between placement's read and this write keeps the slot,
 * and nothing else of the retraction (suppression, intent) happens. True when it archived the slot. `todayToo` is the pass
 * saying a pause covers today (`flexible`).
 */
export async function retractSlot(
  db: Db,
  userId: string,
  slot: Pick<WorkoutRow, "id">,
  today: string,
  prefs: UserPreferences,
  now: string,
  { todayToo = false }: { todayToo?: boolean } = {},
): Promise<boolean> {
  const removed = await removeFromPlan(db, userId, slot.id, {
    now,
    source: "program_replace",
    prefs,
    archiveReason: "program_replaced",
    onlyIf: and(
      isNull(plannedWorkouts.archivedAt),
      eq(plannedWorkouts.origin, "program"),
      eq(plannedWorkouts.completionState, "scheduled"),
      eq(plannedWorkouts.contentState, "outline"),
      sql`${plannedWorkouts.effectiveDate} = ${plannedWorkouts.originalPlanDate}`,
      todayToo ? gte(plannedWorkouts.effectiveDate, today) : gt(plannedWorkouts.effectiveDate, today),
      sql`not ${TOUCHED}`,
    ),
  });
  return removed.removed;
}

/**
 * Rule 6's written session, retracted through the document removal path, and re-checked as it archives as `retractSlot`
 * re-checks: a build, a start, a move, a re-time or a completion landing since the pass read it keeps it. True when it left.
 */
async function retractWritten(db: Db, userId: string, slot: Pick<WorkoutRow, "id">, today: string, prefs: UserPreferences, now: string): Promise<boolean> {
  try {
    await removeDocWorkout(db, userId, slot.id, { today, now, prefs }, {
      source: "program_replace",
      archiveReason: "program_replaced",
      onlyIf: and(
        eq(plannedWorkouts.completionState, "scheduled"),
        eq(plannedWorkouts.contentState, "outline"),
        eq(plannedWorkouts.effectiveDate, today),
        eq(plannedWorkouts.originalPlanDate, today),
        sql`not ${TOUCHED}`,
      ),
    });
    return true;
  } catch (e) {
    if (e instanceof NotRemovableError || e instanceof RestoreInProgressError || e instanceof DocWorkoutNotFoundError) return false;
    throw e;
  }
}

/** The week's dates in placement order: preferred days as listed, then the rest Monday → Sunday, unless these are its only days. */
function rankedDays(monday: string, preferredDays: readonly number[], onlyThese: boolean): string[] {
  const rest = onlyThese ? [] : [0, 1, 2, 3, 4, 5, 6].filter((d) => !preferredDays.includes(d));
  return [...preferredDays, ...rest].map((d) => addDays(monday, d));
}

/** The athlete's wall clock at an instant: their local date and "HH:MM". */
function localClock(instant: string, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}

/** Whether `today`'s session window (`windowTime`) is already behind the athlete at `now`. */
function windowGone(today: string, windowTime: string, now: string, timezone: string): boolean {
  const clock = localClock(now, timezone);
  return clock.date > today || (clock.date === today && clock.time >= windowTime);
}

/** The window placement works over: this ISO week to `placementWeeksAhead` weeks ahead. */
function windowOf(today: string, config: SlotPattern): { firstMonday: string; lastSunday: string } {
  const firstMonday = startOfIsoWeek(today);
  return { firstMonday, lastSunday: addDays(firstMonday, 7 * (config.placementWeeksAhead + 1) - 1) };
}

/**
 * The program's slots placement reads (one statement): planned in the window (rule 1's count, and every id a new slot
 * could take), or sitting in it now (a slot moved in from outside still holds its date). A program that wants no slots
 * (`goal` 0) also reads every live slot past the window: retiring retracts its flexible future slots wherever an
 * earlier, wider window put them (M2). A course reads its own sessions once written too (`course_session`), so each still
 * holds its day; a workout the coach filed under the plan isn't one of them.
 */
async function readSlotRows(db: Db, userId: string, programId: string, today: string, config: SlotPattern, goal: number, isCourse: boolean): Promise<WorkoutRow[]> {
  const { firstMonday, lastSunday } = windowOf(today, config);
  return db
    .select(plannedRowColumns())
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, programId),
        isCourse ? or(eq(plannedWorkouts.origin, "program"), isNotNull(plannedWorkouts.courseSession)) : eq(plannedWorkouts.origin, "program"),
        or(
          and(gte(plannedWorkouts.originalPlanDate, firstMonday), lte(plannedWorkouts.originalPlanDate, lastSunday)),
          and(gte(plannedWorkouts.effectiveDate, firstMonday), lte(plannedWorkouts.effectiveDate, lastSunday)),
          goal === 0 ? and(isNull(plannedWorkouts.archivedAt), gt(plannedWorkouts.effectiveDate, lastSunday)) : undefined,
        ),
      ),
    );
}

/** What placement weighs beside the rows: the program, how it places (`Placement`), and the clock. */
interface PlanInputs extends Pick<Placement, "config" | "goal" | "time" | "quietDays" | "isCourse"> {
  programId: string;
  /** `programs.paused_until`: no new sessions up to and including it. */
  pausedUntil: string | null;
  today: string;
  prefs: UserPreferences;
  now: string;
  discipline: "strength" | "yoga";
}

/** Rule 6, as a question about a date. A race already run quiets nothing: every date still ahead is past its last quiet day. */
function heldBackDays({ pausedUntil, quietDays, prefs }: Pick<PlanInputs, "pausedUntil" | "quietDays" | "prefs">): (date: string) => boolean {
  const quiet = prefs.raceDate && quietDays !== null ? { from: addDays(prefs.raceDate, -quietDays), to: prefs.raceDate } : null;
  return (date) => pausedOn(pausedUntil, date) || (quiet !== null && date >= quiet.from && date <= quiet.to);
}

/** Rules 1–4 and 6 over the rows as read: the slots to retract, to bring back and to place — `flexibleIds` the ones that may go. */
function planSlots(rows: readonly WorkoutRow[], o: PlanInputs, flexibleIds: ReadonlySet<string>) {
  const { programId, config, goal, today, prefs, now, discipline } = o;
  const { firstMonday, lastSunday } = windowOf(today, config);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Rule 2's two limits on a NEW slot (ruling 2a-R11): never on today once today's window has passed (it would
  // only become a "Did this happen?" and a miss), and in this week only on the days a full week would hold one —
  // a program started (or a goal raised) mid-week does not cram the week's goal into what is left of it.
  const todayGone = windowGone(today, o.time ?? windowTimeFor({ category: discipline, date: today }, prefs), now, prefs.timezone);
  const heldBack = heldBackDays(o);
  // One slot of this program per date: the days a live, fixed slot already sits on.
  const occupied = new Set(rows.filter((r) => r.archivedAt === null && !flexibleIds.has(r.id)).map((r) => r.effectiveDate));
  const toArchive: WorkoutRow[] = [];
  const toRevive: WorkoutRow[] = [];
  const toInsert: string[] = [];
  for (let week = 0; week <= config.placementWeeksAhead; week++) {
    const monday = addDays(firstMonday, 7 * week);
    const sunday = addDays(monday, 6);
    const counted = rows.filter((r) => r.originalPlanDate >= monday && r.originalPlanDate <= sunday && !retracted(r));
    const movable = new Map(counted.filter((r) => flexibleIds.has(r.id)).map((r) => [r.effectiveDate, r]));
    const need = Math.max(0, goal - (counted.length - movable.size));
    const ranked = rankedDays(monday, config.preferredDays, o.isCourse);
    const weekDays = week === 0 || ranked.some(heldBack) ? new Set(ranked.slice(0, goal)) : null;

    const want = new Set<string>();
    for (const date of ranked) {
      if (want.size >= need) break;
      // Race day is the race's: no session there, and a flexible one placed before the race was set moves off it.
      if (date === prefs.raceDate) continue;
      // Rule 6: nothing goes on a day held back, and a flexible slot already there isn't wanted, so it comes off.
      if (heldBack(date)) continue;
      if (movable.has(date)) {
        want.add(date);
        continue;
      }
      if (date < today || occupied.has(date)) continue;
      if (weekDays && !weekDays.has(date)) continue;
      if (date === today && todayGone) continue;
      // The date's id belongs to a slot the athlete moved away, skipped or removed: that day is spoken for.
      const holder = byId.get(slotId(programId, date));
      if (holder && !retracted(holder)) continue;
      want.add(date);
    }

    for (const [date, r] of movable) if (!want.has(date)) toArchive.push(r);
    for (const date of want) {
      if (movable.has(date)) continue;
      const holder = byId.get(slotId(programId, date));
      if (holder) toRevive.push(holder);
      else toInsert.push(date);
    }
  }
  // Past the window only a program that wants no slots reads anything: every flexible one there goes.
  for (const r of rows) if (r.effectiveDate > lastSunday && flexibleIds.has(r.id)) toArchive.push(r);
  return { toArchive, toRevive, toInsert };
}

/**
 * Rule 3 by the row first; the touched check (one lookup per TOUCHED_ID_CHUNK ids: `touchedReads`) only when the plan
 * would retract something — when it retracts nothing, a touched slot and an untouched one are kept alike and the plan
 * is the same.
 */
async function planWithTouched(db: Db, rows: readonly WorkoutRow[], o: PlanInputs) {
  const todayToo = pausedOn(o.pausedUntil, o.today);
  const byRow = rows.filter((r) => flexible(r, o.today, todayToo) || writtenOffToday(r, o.today, todayToo)).map((r) => r.id);
  let planned = planSlots(rows, o, new Set(byRow));
  let touchedReads = 0;
  if (planned.toArchive.length > 0) {
    touchedReads = Math.ceil(byRow.length / TOUCHED_ID_CHUNK);
    const touched = await touchedSlots(db, byRow);
    if (touched.size > 0) planned = planSlots(rows, o, new Set(byRow.filter((id) => !touched.has(id))));
  }
  return { ...planned, touchedReads };
}

/** The most statements `previewPlacement` runs: the rows, and one touched lookup (a window holds far under 80 slots). */
export const PREVIEW_STATEMENTS = 2;

/**
 * What a pass would leave with `config` in place of the program's own, written nowhere (change_programme's card: "Next
 * sessions move to …"): the dates of its live, scheduled sessions from today on, before and after. Rules 1–4 exactly
 * as a pass runs them, a pause included; the content refresh (rule 5) moves no session. An adaptive program's: only
 * change_programme asks.
 */
export async function previewPlacement(
  db: Db,
  userId: string,
  program: Pick<ProgramRow, "id" | "status" | "disciplines" | "pausedUntil">,
  config: AdaptiveConfig,
  today: string,
  prefs: UserPreferences,
  now: string,
): Promise<{ before: string[]; after: string[] }> {
  const goal = program.status === "active" ? config.weeklyGoal : 0;
  const rows = await readSlotRows(db, userId, program.id, today, config, goal, false);
  const plan = await planWithTouched(db, rows, {
    programId: program.id,
    config,
    goal,
    time: null,
    quietDays: null,
    isCourse: false,
    pausedUntil: program.pausedUntil,
    today,
    prefs,
    now,
    discipline: defaultDiscipline(program),
  });
  const live = rows.filter((r) => r.archivedAt === null && r.completionState === "scheduled" && r.effectiveDate >= today);
  const gone = new Set(plan.toArchive.map((r) => r.id));
  const before = live.map((r) => r.effectiveDate).sort();
  const after = [...live.filter((r) => !gone.has(r.id)).map((r) => r.effectiveDate), ...plan.toInsert, ...plan.toRevive.map((r) => r.originalPlanDate)]
    .filter((d) => d >= today)
    .sort();
  return { before, after };
}

/**
 * Place (and re-place) one program's slots. Idempotent: a second run with the same inputs writes nothing.
 * Not this user's program, neither adaptive nor a course, or a restore in progress → nothing. A program that is not
 * active wants no slots, so its flexible ones are retracted and none are placed. Everything in one pass, however long: the
 * hourly pass's way (a request places within its budget, `placeSlotsWithin`).
 */
export async function placeSlots(
  db: Db,
  userId: string,
  programId: string,
  today: string,
  prefs: UserPreferences,
  now: string,
): Promise<PlacementResult> {
  const { placed, archived } = await place(db, userId, programId, today, prefs, now, null);
  return { placed, archived };
}

/**
 * `placeSlots` within `budget` statements (a request's room): the same rule, a step at a time — the retractions first,
 * then the slots to place, bring back or refresh, each with its day's collision pass — as many as their declared costs
 * fit, and `more` when something is left. The pass's first step always runs, so every pass gets somewhere; the next
 * pass carries on from the rows (nothing is stored between them), and the hourly pass finishes whatever no request
 * came back for.
 */
export async function placeSlotsWithin(
  db: Db,
  userId: string,
  programId: string,
  today: string,
  prefs: UserPreferences,
  now: string,
  budget: number,
): Promise<BudgetedPlacement> {
  return place(db, userId, programId, today, prefs, now, budget);
}

/**
 * A CHANGE TO A PLAN'S PAUSE TAKES EFFECT IN ITS OWN REQUEST (rulings R23, R25): its pass, within what the request has left,
 * through `PATCH /api/plans/:id` and through approving the coach's change. It answers what it spent. The change has landed by
 * now, so a pass that fails is logged by code and left to the hourly pass, which finishes what doesn't fit anyway; it never
 * turns a pause that landed into an error. Our own runtime ceiling goes on up: the invocation is over.
 */
export async function placeAfterPauseChange(db: Db, userId: string, planId: string, today: string, prefs: UserPreferences, now: string, budget: number): Promise<number> {
  try {
    return (await placeSlotsWithin(db, userId, planId, today, prefs, now, budget)).spent;
  } catch (e) {
    if (isRuntimeLimit(e)) throw e;
    console.error(`pause_placement_failed: plan ${planId} ${e instanceof Error ? e.name : "unknown"}`);
    return budget;
  }
}

/**
 * A course plan's sessions actually done, which numbers its next one (spec §4.2): its own sessions (`course_session` set)
 * that are completed. Nothing else counts, so a workout the coach filed under the plan doesn't advance it. One statement.
 */
export async function courseSessionsDone(db: Db, userId: string, programId: string): Promise<number> {
  const [done] = await db
    .select({ n: count() })
    .from(plannedWorkouts)
    .where(and(eq(plannedWorkouts.userId, userId), eq(plannedWorkouts.planId, programId), isNotNull(plannedWorkouts.courseSession), eq(plannedWorkouts.completionState, "completed")));
  return done?.n ?? 0;
}

/**
 * What a pass places from, whichever kind makes the sessions; null when nothing can be placed: another kind, a course part way
 * through its start, or a running course whose definition is gone (an old id), which is logged by code and leaves the pass with
 * nothing to do. A stopped
 * course needs no definition: it only retracts, through goal 0. A course's outlines book the next session as it would be
 * uneased: easing is one session's, used and cleared when it's written.
 */
async function placementOf(db: Db, program: ProgramRow, spend: (n: number) => void): Promise<Placement | null> {
  const active = program.status === "active";
  if (program.kind === "adaptive") {
    const config = adaptiveConfigSchema.parse(program.config);
    const seconds = config.defaultMinutes * 60;
    return { config, goal: active ? config.weeklyGoal : 0, length: { seconds, booked: seconds }, title: program.name, time: null, quietDays: null, isCourse: false, watchOff: false };
  }
  if (program.kind !== "course") return null;
  const config = courseConfigSchema.parse(program.config);
  if (config.finishing === "start") return null;
  const placement = {
    config: { weeklyGoal: config.weekdays.length, preferredDays: config.weekdays, placementWeeksAhead: config.placementWeeksAhead },
    title: program.name,
    time: config.time,
    quietDays: config.quietDaysBeforeRace,
    isCourse: true,
  };
  // A stopped course places nothing, so whether it would place kept off is no matter.
  if (!active) return { ...placement, goal: 0, length: null, watchOff: false };
  const course = courseDefinition(config.course);
  if (!course) {
    console.error(`course_definition_missing: program ${program.id}`);
    return null;
  }
  spend(1);
  const done = await courseSessionsDone(db, program.userId, program.id);
  const seconds = deriveDoc(course.sessionDoc(done + 1, { ease: false }), EXERCISES).estimatedMinutes * 60;
  // The header's A COURSE: the flag, read here and nowhere else.
  return { ...placement, goal: config.weekdays.length, length: { seconds, booked: bookedSeconds(seconds) }, watchOff: course.watch === false };
}

async function place(
  db: Db,
  userId: string,
  programId: string,
  today: string,
  prefs: UserPreferences,
  now: string,
  budget: number | null,
): Promise<BudgetedPlacement> {
  const result: BudgetedPlacement = { placed: [], archived: [], more: false, spent: 0 };
  // The pass's declared statements, as it goes (read only when it has a budget).
  const spend = (n: number) => void (result.spent += n);
  spend(1);
  if (await restoreInProgress(db, userId)) return result;
  spend(1);
  const [program] = await db
    .select()
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.userId, userId)))
    .limit(1);
  if (!program) return result;
  const placement = await placementOf(db, program, spend);
  if (!placement) return result;
  const { config, goal, length, title, time, isCourse, watchOff } = placement;

  const discipline = defaultDiscipline(program);
  spend(1);
  const rows = await readSlotRows(db, userId, programId, today, config, goal, isCourse);
  const { toArchive, toRevive, toInsert, touchedReads } = await planWithTouched(db, rows, { ...placement, programId, pausedUntil: program.pausedUntil, today, prefs, now, discipline });
  spend(touchedReads);

  // A restore that began since this pass's first look owns the account now (audit 2a-model M5): slot ids are
  // the file's ids too, so not one write may land. Looked at again right before each kind of write.
  const restoreBegan = () => restoreInProgress(db, userId);

  // Retract first, then fill (spec: archive, then place the new pattern). Within a budget, as many as fit — the
  // first always — and the fill waits for the next pass while any is left.
  if (toArchive.length > 0) spend(1);
  if (toArchive.length > 0 && (await restoreBegan())) return result;
  const costOfRetracting = (r: WorkoutRow): number => (writtenSession(r) ? RETRACT_WRITTEN_COST : RETRACT_COST);
  let room = budget === null ? Number.POSITIVE_INFINITY : budget - result.spent;
  // The soonest first, whatever order the rows were read in: today's is the one a pause can't leave for later.
  const inTurn = [...toArchive].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate) || a.id.localeCompare(b.id));
  const retracting = inTurn.filter((r, i) => {
    const fits = i === 0 || costOfRetracting(r) <= room;
    if (fits) room -= costOfRetracting(r);
    return fits;
  });
  const todayToo = pausedOn(program.pausedUntil, today);
  for (const r of retracting) {
    spend(costOfRetracting(r));
    const off = writtenSession(r) ? await retractWritten(db, userId, r, today, prefs, now) : await retractSlot(db, userId, r, today, prefs, now, { todayToo });
    if (off) result.archived.push(r.id);
  }
  if (retracting.length < toArchive.length) {
    result.more = true;
    return result;
  }

  // A stopped course has only retracted: goal 0 fills nothing, and what still stands keeps what it said.
  if (!length) return result;
  const { seconds, booked } = length;

  const content = (date: string) => ({
    title,
    category: discipline,
    sport: discipline,
    effectiveTime: time ?? windowTimeFor({ category: discipline, date }, prefs),
    fallbackEstimatedDurationSeconds: seconds,
    calendarBlockDurationSeconds: booked,
  });

  // Every column, defaulted ones included: `chunkedInsert` sizes batches by the row's own keys, and Drizzle binds
  // a default for any key a row omits (P1-R12).
  const freshRow = (date: string) => {
    const id = slotId(programId, date);
    return {
      id,
      userId,
      planId: programId,
      sourceWorkoutId: id,
      sourceProgramId: null,
      sourceIdInPlan: null,
      qualitySubtype: null,
      originalPlanDate: date,
      lastVerifiedCorosDate: "",
      effectiveDate: date,
      sourceContentFingerprint: "program",
      sourceVersion: null,
      sourceEstimatedDurationSeconds: null,
      durationEstimate: null,
      expectedDistanceMeters: null,
      stageSummary: null,
      structuredJson: null,
      calendarSyncState: "not_created",
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      missingReads: 0,
      snoozedUntil: null,
      resolutionDate: null,
      sanctionedBy: null,
      archivedAt: null,
      archiveReason: null,
      origin: "program",
      contentState: "outline",
      sessionParams: null,
      // The header's A COURSE: kept off the watch from the moment it exists, or on, as every other kind's.
      watchOff,
      createdAt: now,
      updatedAt: now,
      ...content(date),
    };
  };
  const insert = async (dates: readonly string[]): Promise<boolean> => {
    const fresh = dates.map(freshRow);
    if (fresh.length > 0 && (await restoreBegan())) return false;
    await chunkedInsert(fresh, (batch) => db.insert(plannedWorkouts).values(batch).onConflictDoNothing());
    result.placed.push(...fresh.map((r) => r.id));
    return true;
  };
  // A retracted slot whose day is wanted again: the same row comes back, as a fresh outline on its own day, a session written
  // before it left too (its document kept in its history, and its next write the next revision). Its Keep off my watch stays as
  // the row has it (the header's A COURSE): the course's own from its placing, or the athlete's choice since.
  const revive = async (revived: readonly WorkoutRow[]): Promise<boolean> => {
    if (revived.length > 0 && (await restoreBegan())) return false;
    for (const r of revived) {
      await db
        .update(plannedWorkouts)
        .set({
          ...content(r.originalPlanDate),
          effectiveDate: r.originalPlanDate,
          completionState: "scheduled",
          contentState: "outline",
          sessionParams: null,
          resolutionDate: null,
          snoozedUntil: null,
          missingReads: 0,
          archivedAt: null,
          archiveReason: null,
          ...(r.calendarSyncState === "synced" ? { calendarSyncState: "pending" } : {}),
          // A session written before it left may have had a copy: that's its delete's now, which holds its own address (the
          // queued job's payload, or what `unpushBuild` kept with one owed), so the outline holds none of it, as `freshRow`'s doesn't.
          // A slot never written has none of this.
          ...(writtenSession(r)
            ? {
                origin: "program",
                courseSession: null,
                workoutDoc: null,
                sourceContentFingerprint: "program",
                sourceWorkoutId: r.id,
                sourceIdInPlan: null,
                sourceProgramId: null,
                watchCopyName: null,
                corosSyncState: "calendar_only",
                lastVerifiedCorosDate: "",
              }
            : {}),
          updatedAt: now,
        })
        .where(and(eq(plannedWorkouts.id, r.id), eq(plannedWorkouts.userId, userId)));
      // Its suppression goes with the archive it explained, or the calendar would never book it again. Its overrides too: the
      // move or re-time they record is over, and left behind they'd read as the athlete's touch for good (`TOUCHED`).
      await db.delete(calendarEventSuppressions).where(eq(calendarEventSuppressions.workoutId, r.id));
      await db.delete(scheduleOverrides).where(eq(scheduleOverrides.workoutId, r.id));
      result.placed.push(r.id);
    }
    return true;
  };

  if (budget === null) {
    if (!(await insert(toInsert))) return result;
    if (!(await revive(toRevive))) return result;
    const refreshedDates = await refreshSlotContent(db, userId, program, { discipline, seconds, booked, title }, today, now, restoreBegan);
    if (refreshedDates === null) return result;

    const placedDates = [...toInsert, ...toRevive.map((r) => r.originalPlanDate), ...refreshedDates];
    if (placedDates.length > 0) {
      await separateDayCollisions(db, userId, placedDates, prefs, { from: today, now });
    }
    return result;
  }

  // ── Within the budget: what the fill would do, and as much of it as fits ──────────────────────────────────────────
  // Rule 5's changes are read first here (the rows a fill brings in already say what the program says, so the set is
  // the same as read after it): the live read, and the build lookup for the built ones.
  const ran = retracting.length > 0;
  if (ran && result.spent + 2 > budget) {
    result.more = true;
    return result;
  }
  const live = await refreshReads(db, userId, program, today);
  spend(1 + Math.ceil(live.builtCount / BUILD_ID_CHUNK));
  const changes = refreshChanges(live, program, { discipline, seconds, booked, title });

  type Unit = { kind: "insert"; date: string } | { kind: "revive"; r: WorkoutRow } | { kind: "refresh"; change: RefreshChange };
  const units: Unit[] = [
    ...toInsert.map((date) => ({ kind: "insert" as const, date })),
    ...toRevive.map((r) => ({ kind: "revive" as const, r })),
    ...changes.map((change) => ({ kind: "refresh" as const, change })),
  ];
  if (units.length === 0) return result;
  const dateOf = (u: Unit) => (u.kind === "insert" ? u.date : u.kind === "revive" ? u.r.originalPlanDate : u.change.r.effectiveDate);

  // The collision pass's bound: the live, scheduled sessions each day already holds (one read).
  const days = [...new Set(units.map(dateOf))].filter((d) => d >= today);
  spend(Math.ceil(days.length / ID_CHUNK));
  const dayRows = await liveSessionsByDay(db, userId, days);

  // The fill's cost for its first `n` units: a restore check before each kind of write, the insert statements, two
  // statements a revive, one a refresh — then the collision pass's two reads and, for each day touched, every session
  // it holds (a new slot among them) re-timed at most once.
  const costOf = (n: number): number => {
    const chosen = units.slice(0, n);
    const inserts = chosen.flatMap((u) => (u.kind === "insert" ? [u.date] : []));
    const revives = chosen.filter((u) => u.kind === "revive").length;
    const refreshes = chosen.filter((u) => u.kind === "refresh").length;
    const kinds = (inserts.length > 0 ? 1 : 0) + (revives > 0 ? 1 : 0) + (refreshes > 0 ? 1 : 0);
    const added = new Map<string, number>();
    for (const u of chosen) if (u.kind !== "refresh") added.set(dateOf(u), (added.get(dateOf(u)) ?? 0) + 1);
    const touchedDays = new Set(chosen.map(dateOf).filter((d) => d >= today));
    let collisions = touchedDays.size > 0 ? 2 : 0;
    for (const d of touchedDays) collisions += (dayRows.get(d) ?? 0) + (added.get(d) ?? 0);
    return kinds + insertBatches(inserts.map(freshRow)).length + REVIVE_COST * revives + refreshes + collisions;
  };
  let take = 0;
  while (take < units.length && result.spent + costOf(take + 1) <= budget) take += 1;
  // A pass always gets somewhere: the first step runs even past the budget when nothing else has.
  if (take === 0 && !ran) take = 1;
  if (take === 0) {
    result.more = true;
    return result;
  }
  spend(costOf(take));
  const chosen = units.slice(0, take);
  const inserts = chosen.flatMap((u) => (u.kind === "insert" ? [u.date] : []));
  const revives = chosen.flatMap((u) => (u.kind === "revive" ? [u.r] : []));
  const refreshes = chosen.flatMap((u) => (u.kind === "refresh" ? [u.change] : []));
  if (!(await insert(inserts))) return result;
  if (!(await revive(revives))) return result;
  if (refreshes.length > 0 && (await restoreBegan())) return result;
  await writeRefresh(db, userId, refreshes, now);
  await separateDayCollisions(db, userId, chosen.map(dateOf), prefs, { from: today, now });
  result.more = take < units.length;
  return result;
}

/** The live, scheduled, non-rest sessions each of `days` holds — what the collision pass may re-time there. */
async function liveSessionsByDay(db: Db, userId: string, days: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const batch of chunkIds([...days], ID_CHUNK)) {
    const rows = await db
      .select({ date: plannedWorkouts.effectiveDate, n: count() })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          inArray(plannedWorkouts.effectiveDate, batch),
          isNull(plannedWorkouts.archivedAt),
          eq(plannedWorkouts.completionState, "scheduled"),
          ne(plannedWorkouts.category, "rest"),
        ),
      )
      .groupBy(plannedWorkouts.effectiveDate);
    for (const r of rows) out.set(r.date, r.n);
  }
  return out;
}

/** A built session's title: the program's name, then the build's theme (Phase 2 spec §2a "Build rules"). */
export function builtSessionTitle(programName: string, themeName: string | null | undefined): string {
  return themeName ? `${programName} · ${themeName}` : programName;
}

/** Bound per statement for the build lookup: the ids plus the query's own version floor. */
const BUILD_ID_CHUNK = 80;

/**
 * Rule 5: a slot shows what its program says NOW. A rename, a new `defaultMinutes` or a new lead discipline reaches
 * every live, still-scheduled slot of the program dated today or later — wherever it sits, moved or not:
 *  - an OUTLINE takes the name, the length and the default discipline (it has no content of its own yet);
 *  - a BUILT, not-started session takes only the name, before its build's theme — its discipline and length are
 *    the build's.
 * Started, done, resolved and past rows are history and keep what they said, and a course's written session isn't a slot
 * any more (`origin = 'studio'`), so it keeps its own. Only rows that differ are written, so a settled program writes
 * nothing; a written event is flipped to `pending` so the calendar re-derives it.
 * Returns the dates whose rows changed, for the collision pass — or null, writing nothing, when `restoreBegan`
 * says a restore owns the account now (asked once, before the first write).
 */
async function refreshSlotContent(
  db: Db,
  userId: string,
  program: ProgramRow,
  content: { discipline: "strength" | "yoga"; seconds: number; booked: number; title: string },
  today: string,
  now: string,
  restoreBegan: () => Promise<boolean>,
): Promise<string[] | null> {
  const changes = refreshChanges(await refreshReads(db, userId, program, today), program, content);
  if (changes.length > 0 && (await restoreBegan())) return null;
  return writeRefresh(db, userId, changes, now);
}

/** Rule 5's reads: the program's live, scheduled slots from today on, and each built one's theme. */
async function refreshReads(db: Db, userId: string, program: ProgramRow, today: string) {
  const live = await db
    .select({
      id: plannedWorkouts.id,
      effectiveDate: plannedWorkouts.effectiveDate,
      title: plannedWorkouts.title,
      category: plannedWorkouts.category,
      sport: plannedWorkouts.sport,
      fallbackEstimatedDurationSeconds: plannedWorkouts.fallbackEstimatedDurationSeconds,
      calendarBlockDurationSeconds: plannedWorkouts.calendarBlockDurationSeconds,
      contentState: plannedWorkouts.contentState,
      calendarSyncState: plannedWorkouts.calendarSyncState,
    })
    .from(plannedWorkouts)
    .where(
      and(
        eq(plannedWorkouts.userId, userId),
        eq(plannedWorkouts.planId, program.id),
        eq(plannedWorkouts.origin, "program"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        gte(plannedWorkouts.effectiveDate, today),
        inArray(plannedWorkouts.contentState, ["outline", "built"]),
      ),
    );

  // A built session's theme, from its latest real build — read in SQL, never by parsing the whole payload.
  const builtIds = live.filter((r) => r.contentState === "built").map((r) => r.id);
  const themeOf = new Map<string, { version: number; theme: string | null }>();
  for (const batch of chunkIds(builtIds, BUILD_ID_CHUNK)) {
    const builds = await db
      .select({
        workoutId: sessionBuilds.workoutId,
        version: sessionBuilds.version,
        theme: sql<string | null>`json_extract(${sessionBuilds.payload}, '$.view.theme.name')`,
      })
      .from(sessionBuilds)
      .where(and(inArray(sessionBuilds.workoutId, batch), gt(sessionBuilds.version, 0)));
    for (const b of builds) {
      const seen = themeOf.get(b.workoutId);
      if (!seen || b.version > seen.version) themeOf.set(b.workoutId, { version: b.version, theme: b.theme });
    }
  }
  return { live, themeOf, builtCount: builtIds.length };
}

type RefreshReads = Awaited<ReturnType<typeof refreshReads>>;
/** One slot rule 5 rewrites, and what it writes. */
interface RefreshChange {
  r: RefreshReads["live"][number];
  want: Partial<typeof plannedWorkouts.$inferInsert>;
}

/** Rule 5's writes, worked out from its reads: only the rows that differ. */
function refreshChanges(
  { live, themeOf }: RefreshReads,
  program: ProgramRow,
  content: { discipline: "strength" | "yoga"; seconds: number; booked: number; title: string },
): RefreshChange[] {
  const changes: RefreshChange[] = [];
  for (const r of live) {
    let want: Partial<typeof plannedWorkouts.$inferInsert>;
    if (r.contentState === "outline") {
      want = {
        title: content.title,
        category: content.discipline,
        sport: content.discipline,
        fallbackEstimatedDurationSeconds: content.seconds,
        calendarBlockDurationSeconds: content.booked,
      };
    } else {
      const built = themeOf.get(r.id);
      if (!built) continue; // no build to read the theme from: leave the row as its build wrote it
      want = { title: builtSessionTitle(program.name, built.theme) };
    }
    const differs = (Object.keys(want) as Array<keyof typeof want>).some(
      (k) => want[k] !== (r as Record<string, unknown>)[k],
    );
    if (differs) changes.push({ r, want });
  }
  return changes;
}

/** Rule 5's writes, one a row; the dates whose rows changed, for the collision pass. */
async function writeRefresh(db: Db, userId: string, changes: readonly RefreshChange[], now: string): Promise<string[]> {
  const changedDates: string[] = [];
  for (const { r, want } of changes) {
    await db
      .update(plannedWorkouts)
      .set({
        ...want,
        ...(r.calendarSyncState === "synced" ? { calendarSyncState: "pending" } : {}),
        updatedAt: now,
      })
      .where(and(eq(plannedWorkouts.id, r.id), eq(plannedWorkouts.userId, userId)));
    changedDates.push(r.effectiveDate);
  }
  return changedDates;
}

export interface PlacementSweepStats {
  programs: number;
  placed: number;
  archived: number;
  failed: number;
}

/**
 * The hourly pass: every active adaptive program and course of every user keeps its weeks filled as the days roll on — and
 * every one that is NOT active but still owns a flexible-looking slot after its user's today is
 * visited too, so its goal-0 pass retracts it (audit 2a-model M2: a retire racing this pass, which read the
 * program as active and placed the far week after the retire's own pass ran). Each user's today is in their own
 * timezone; an account a restore is replacing is skipped; one program failing does not stop the rest.
 */
export async function placeSlotsForAllPrograms(db: Db, at: Date = new Date()): Promise<PlacementSweepStats> {
  const stats: PlacementSweepStats = { programs: 0, placed: 0, archived: 0, failed: 0 };
  const active = await db
    .select({ id: programs.id, userId: programs.userId })
    .from(programs)
    .where(and(inArray(programs.kind, PLACED_KINDS), eq(programs.status, "active")));
  // Every zone's today is at most a day behind UTC's, so a slot still ahead of its athlete is dated on or after
  // UTC's today; each candidate is then held to its own user's today below.
  const lingering = await db
    .select({ id: programs.id, userId: programs.userId, latest: max(plannedWorkouts.effectiveDate) })
    .from(programs)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.planId, programs.id))
    .where(
      and(
        inArray(programs.kind, PLACED_KINDS),
        ne(programs.status, "active"),
        eq(plannedWorkouts.userId, programs.userId),
        eq(plannedWorkouts.origin, "program"),
        isNull(plannedWorkouts.archivedAt),
        eq(plannedWorkouts.completionState, "scheduled"),
        eq(plannedWorkouts.contentState, "outline"),
        sql`${plannedWorkouts.effectiveDate} = ${plannedWorkouts.originalPlanDate}`,
        gte(plannedWorkouts.effectiveDate, todayInZone("UTC", at)),
      ),
    )
    .groupBy(programs.id, programs.userId);
  const byUser = new Map<string, Array<{ id: string; latest: string | null }>>();
  for (const p of active) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), { id: p.id, latest: null }]);
  for (const p of lingering) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), { id: p.id, latest: p.latest }]);

  const now = nowInstant(at);
  for (const [userId, candidates] of byUser) {
    if (await restoreInProgress(db, userId)) continue;
    const prefs = await loadPreferences(db, userId);
    const today = todayInZone(prefs.timezone, at);
    // An active program always; one that is not, only while a slot of it is still ahead of today.
    const programIds = candidates.filter((c) => c.latest === null || c.latest > today).map((c) => c.id);
    for (const programId of programIds) {
      stats.programs += 1;
      try {
        const res = await placeSlots(db, userId, programId, today, prefs, now);
        stats.placed += res.placed.length;
        stats.archived += res.archived.length;
      } catch (e) {
        stats.failed += 1;
        console.error(`slot placement failed for program ${programId}: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  }
  return stats;
}
