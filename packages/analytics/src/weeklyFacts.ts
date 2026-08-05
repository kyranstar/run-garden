import type { DateRange, LocalDate, NormalizedActivity, PlannedWorkout } from "@rg/domain";
import { inRange, isQuality, startOfIsoWeek } from "@rg/domain";
import type { PersonalRecord } from "./records.js";

/**
 * Deterministic facts for the weekly review. A downstream LLM formatter may
 * phrase these later; this module only computes — every string here is a pure
 * function of its inputs.
 */

export interface GardenEventSummary {
  plantsAdded: number;
  wildlife: number;
}

export interface WeeklyFactsInput {
  /** The week being reviewed (inclusive range). */
  range: DateRange;
  /** Planned workouts for that week. */
  workouts: PlannedWorkout[];
  /** Activities matched to that week. */
  activities: NormalizedActivity[];
  garden: GardenEventSummary;
  /** Optional record history; the first record achieved this week is surfaced. */
  records?: PersonalRecord[];
}

export interface WeeklyFacts {
  weekStart: LocalDate;
  planned: number;
  completed: number;
  moved: number;
  skipped: number;
  totalDurationSeconds: number;
  totalDistanceMeters: number;
  qualitySessions: number;
  longRunCompleted: boolean;
  adherencePct: number;
  notableRecord?: string;
  gardenSummary: string;
}

function gardenSummary(garden: GardenEventSummary): string {
  const parts: string[] = [];
  if (garden.plantsAdded === 1) parts.push("1 new plant took root");
  else if (garden.plantsAdded > 1) parts.push(`${garden.plantsAdded} new plants took root`);
  if (garden.wildlife === 1) parts.push("1 wildlife visitor arrived");
  else if (garden.wildlife > 1) parts.push(`${garden.wildlife} wildlife visitors arrived`);
  return parts.length > 0 ? parts.join("; ") : "A quiet week in the garden";
}

export function computeWeeklyFacts(input: WeeklyFactsInput): WeeklyFacts {
  const considered = input.workouts.filter(
    (w) => w.category !== "rest" && inRange(w.effectiveDate, input.range),
  );
  const completedWorkouts = considered.filter(
    (w) => w.completionState === "completed",
  );
  const future = considered.filter((w) => w.completionState === "scheduled").length;
  const denominator = considered.length - future;

  const facts: WeeklyFacts = {
    weekStart: startOfIsoWeek(input.range.start),
    planned: considered.length,
    completed: completedWorkouts.length,
    moved: completedWorkouts.filter((w) => w.effectiveDate !== w.originalPlanDate).length,
    skipped: considered.filter((w) => w.completionState === "skipped").length,
    totalDurationSeconds: input.activities.reduce((s, a) => s + a.durationSeconds, 0),
    totalDistanceMeters: input.activities.reduce((s, a) => s + (a.distanceMeters ?? 0), 0),
    qualitySessions: completedWorkouts.filter((w) => isQuality(w)).length,
    longRunCompleted: completedWorkouts.some((w) => w.category === "long"),
    adherencePct: denominator > 0 ? Math.round((completedWorkouts.length / denominator) * 100) : 0,
    gardenSummary: gardenSummary(input.garden),
  };

  const notable = (input.records ?? []).find((r) => inRange(r.achievedOn, input.range));
  if (notable) facts.notableRecord = `${notable.title}: ${notable.value}`;

  return facts;
}
