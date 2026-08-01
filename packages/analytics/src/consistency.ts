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

export interface ConsistencyReport {
  planned: number;
  completed: number;
  /** effectiveDate differs from originalPlanDate AND the workout was completed. */
  moved: number;
  skipped: number;
  missed: number;
  unresolved: number;
  /** completed / (planned - still-future); 0 when nothing has resolved yet. */
  adherenceRate: number;
  weeklyBreakdown: WeeklyAdherence[];
}

function isCompleted(w: PlannedWorkout): boolean {
  return w.completionState === "completed" || w.completionState === "provisionally_completed";
}

function isFuture(w: PlannedWorkout): boolean {
  return w.completionState === "scheduled";
}

export function computeConsistency(workouts: PlannedWorkout[], range: DateRange): ConsistencyReport {
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
    else if (w.completionState === "unresolved") unresolved++;
    else if (isFuture(w)) future++;
  }

  const planned = considered.length;
  const resolvedDenominator = planned - future;
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
    const weekDenominator = inWeek.length - inWeek.filter(isFuture).length;
    weeklyBreakdown.push({
      weekStart,
      planned: inWeek.length,
      completed: weekCompleted,
      adherence: weekDenominator > 0 ? weekCompleted / weekDenominator : 0,
    });
  }

  return { planned, completed, moved, skipped, missed, unresolved, adherenceRate, weeklyBreakdown };
}
