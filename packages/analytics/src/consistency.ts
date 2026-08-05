import type { DateRange, LocalDate, PlannedWorkout } from "@rg/domain";
import { addDays, inRange, startOfIsoWeek } from "@rg/domain";

/**
 * Plan consistency over a date range. Always available (no suppression):
 * even one workout yields honest counts. Rest-day workouts are excluded from
 * planned counts, and moving a workout is never a failure — a moved workout
 * that was completed counts as both `moved` and `completed`.
 */

export interface WeeklyAdherence {
  weekStart: LocalDate;
  planned: number;
  completed: number;
  adherence: number;
}

export interface ConsistencyDay {
  date: LocalDate;
  status: "completed" | "moved" | "skipped" | "missed" | "pending" | "rest" | "future" | "none";
}

export interface ConsistencyReport {
  planned: number;
  completed: number;
  /** effectiveDate differs from originalPlanDate AND the workout was completed. */
  moved: number;
  skipped: number;
  missed: number;
  /**
   * Explicitly `unresolved` workouts PLUS still-`scheduled` ones whose date has
   * already passed — the same "sync limbo" the day grid reads as "pending".
   * The two must agree: a bar chart of these counts sits directly above the
   * day grid on the Insights screen, and a workout showing as pending in one
   * and future in the other is a contradiction the reader has to resolve.
   */
  unresolved: number;
  /** Alias of `unresolved` — same number, kept for a clean worker-route migration. */
  pending: number;
  /** completed / (planned - still-ahead - unresolved); 0 when nothing has resolved yet. */
  adherenceRate: number;
  weeklyBreakdown: WeeklyAdherence[];
  /**
   * One status per day, from `range.start` through the END of the ISO week
   * containing `range.end` — i.e. past the range, to the Sunday that closes
   * the current week. The heatmap draws whole week columns, and without those
   * trailing days the current week's remaining slots were indistinguishable
   * from "outside the data" (both blank); they now render as "future".
   */
  days: ConsistencyDay[];
}

function isCompleted(w: PlannedWorkout): boolean {
  return w.completionState === "completed";
}

function isScheduled(w: PlannedWorkout): boolean {
  return w.completionState === "scheduled";
}

/** Scheduled AND not yet due — the only sense in which a workout is "still ahead of you". */
function isStillAhead(w: PlannedWorkout, today: LocalDate): boolean {
  return isScheduled(w) && w.effectiveDate > today;
}

function isUnresolved(w: PlannedWorkout): boolean {
  return w.completionState === "unresolved";
}

/** Highest-precedence status wins when multiple workouts share a date. */
const DAY_STATUS_PRECEDENCE: ReadonlyArray<ConsistencyDay["status"]> = [
  "missed",
  "skipped",
  "pending",
  "moved",
  "completed",
  "future",
  "rest",
];

/**
 * Per-workout day status. Rest-day placeholders always read as "rest".
 * A "scheduled" workout whose effectiveDate has already passed is sync limbo
 * (COROS/completion matching hasn't caught up yet) and reads as "pending",
 * same as an explicitly `unresolved` workout.
 */
function dayStatusForWorkout(w: PlannedWorkout, today: LocalDate): ConsistencyDay["status"] {
  if (w.category === "rest") return "rest";
  if (isCompleted(w)) return w.effectiveDate !== w.originalPlanDate ? "moved" : "completed";
  if (w.completionState === "skipped") return "skipped";
  if (w.completionState === "missed") return "missed";
  if (isUnresolved(w)) return "pending";
  // Only "scheduled" remains.
  return w.effectiveDate <= today ? "pending" : "future";
}

function pickDayStatus(statuses: ConsistencyDay["status"][]): ConsistencyDay["status"] {
  if (statuses.length === 0) return "none";
  let best = statuses[0]!;
  for (const s of statuses) {
    if (DAY_STATUS_PRECEDENCE.indexOf(s) < DAY_STATUS_PRECEDENCE.indexOf(best)) best = s;
  }
  return best;
}

export function computeConsistency(
  workouts: PlannedWorkout[],
  range: DateRange,
  today: LocalDate,
): ConsistencyReport {
  const considered = workouts.filter(
    (w) => w.category !== "rest" && inRange(w.effectiveDate, range),
  );

  let completed = 0;
  let moved = 0;
  let skipped = 0;
  let missed = 0;
  let unresolved = 0;
  let stillAhead = 0;

  for (const w of considered) {
    if (isCompleted(w)) {
      completed++;
      if (w.effectiveDate !== w.originalPlanDate) moved++;
    } else if (w.completionState === "skipped") skipped++;
    else if (w.completionState === "missed") missed++;
    // A past-due `scheduled` workout is pending, not future — see `unresolved`
    // on ConsistencyReport for why the counts have to match the day grid here.
    else if (isUnresolved(w) || (isScheduled(w) && !isStillAhead(w, today))) unresolved++;
    else if (isStillAhead(w, today)) stillAhead++;
  }

  const planned = considered.length;
  // Unchanged by the reclassification above: both branches were already
  // excluded, so moving a workout between them can't move the rate.
  const resolvedDenominator = planned - stillAhead - unresolved;
  const adherenceRate = resolvedDenominator > 0 ? completed / resolvedDenominator : 0;

  // Every ISO week that intersects the range, in order, including empty weeks.
  const weeklyBreakdown: WeeklyAdherence[] = [];
  for (
    let weekStart = startOfIsoWeek(range.start);
    weekStart <= range.end;
    weekStart = addDays(weekStart, 7)
  ) {
    const inWeek = considered.filter((w) => startOfIsoWeek(w.effectiveDate) === weekStart);
    const weekCompleted = inWeek.filter(isCompleted).length;
    const weekDenominator =
      inWeek.length - inWeek.filter(isScheduled).length - inWeek.filter(isUnresolved).length;
    weeklyBreakdown.push({
      weekStart,
      planned: inWeek.length,
      completed: weekCompleted,
      adherence: weekDenominator > 0 ? weekCompleted / weekDenominator : 0,
    });
  }

  // Per-day status grid: every date in range, including days with no workout,
  // then on to the Sunday that closes the ISO week containing range.end so the
  // heatmap's last column is a whole week.
  const gridEnd = addDays(startOfIsoWeek(range.end), 6);
  const byDate = new Map<LocalDate, ConsistencyDay["status"][]>();
  for (const w of workouts) {
    if (w.effectiveDate < range.start || w.effectiveDate > gridEnd) continue;
    const status = dayStatusForWorkout(w, today);
    const list = byDate.get(w.effectiveDate);
    if (list) list.push(status);
    else byDate.set(w.effectiveDate, [status]);
  }
  const days: ConsistencyDay[] = [];
  for (let date = range.start; date <= gridEnd; date = addDays(date, 1)) {
    const statuses = byDate.get(date);
    if (statuses) {
      days.push({ date, status: pickDayStatus(statuses) });
    } else {
      // Past range.end an empty day is "future" ("nothing scheduled YET"),
      // not "none" ("nothing at all") — otherwise the rest of the current week
      // renders as blank space and reads as the end of the data.
      days.push({ date, status: date > range.end ? "future" : "none" });
    }
  }

  return {
    planned,
    completed,
    moved,
    skipped,
    missed,
    unresolved,
    pending: unresolved,
    adherenceRate,
    weeklyBreakdown,
    days,
  };
}
