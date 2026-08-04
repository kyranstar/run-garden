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
  unresolved: number;
  /** Alias of `unresolved` — same number, kept for a clean worker-route migration. */
  pending: number;
  /** completed / (planned - still-future - unresolved); 0 when nothing has resolved yet. */
  adherenceRate: number;
  weeklyBreakdown: WeeklyAdherence[];
  /** Every date in `range`, with a single status per day. */
  days: ConsistencyDay[];
}

function isCompleted(w: PlannedWorkout): boolean {
  return w.completionState === "completed" || w.completionState === "provisionally_completed";
}

function isFuture(w: PlannedWorkout): boolean {
  return w.completionState === "scheduled";
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
  let future = 0;

  for (const w of considered) {
    if (isCompleted(w)) {
      completed++;
      if (w.effectiveDate !== w.originalPlanDate) moved++;
    } else if (w.completionState === "skipped") skipped++;
    else if (w.completionState === "missed") missed++;
    else if (isUnresolved(w)) unresolved++;
    else if (isFuture(w)) future++;
  }

  const planned = considered.length;
  const resolvedDenominator = planned - future - unresolved;
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
      inWeek.length - inWeek.filter(isFuture).length - inWeek.filter(isUnresolved).length;
    weeklyBreakdown.push({
      weekStart,
      planned: inWeek.length,
      completed: weekCompleted,
      adherence: weekDenominator > 0 ? weekCompleted / weekDenominator : 0,
    });
  }

  // Per-day status grid: every date in range, including days with no workout.
  const byDate = new Map<LocalDate, ConsistencyDay["status"][]>();
  for (const w of workouts) {
    if (!inRange(w.effectiveDate, range)) continue;
    const status = dayStatusForWorkout(w, today);
    const list = byDate.get(w.effectiveDate);
    if (list) list.push(status);
    else byDate.set(w.effectiveDate, [status]);
  }
  const days: ConsistencyDay[] = [];
  for (let date = range.start; date <= range.end; date = addDays(date, 1)) {
    days.push({ date, status: pickDayStatus(byDate.get(date) ?? []) });
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
