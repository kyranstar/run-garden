import type { ActivityLap, LocalDate, NormalizedActivity, WorkoutCategory } from "@rg/domain";
import { addDays, daysBetween } from "@rg/domain";
import { computeAerobicEfficiency } from "./aerobicEfficiency.js";
import type { ExecutionInput } from "./execution.js";
import { computeExecution } from "./execution.js";
import { activityLocalDate, median } from "./stats.js";

/**
 * "Invisible personal records": achievements a watch never surfaces, each with
 * a deterministic comparison rule. Records lacking data are simply omitted —
 * no fake records, no extrapolation.
 */

export interface RunSample {
  activity: NormalizedActivity;
  laps: ActivityLap[];
  category: WorkoutCategory;
}

export interface PersonalRecord {
  id: string;
  title: string;
  /** Human-formatted value, e.g. "1.29 m/beat". */
  value: string;
  achievedOn: LocalDate;
  /** One-sentence deterministic definition of the comparison. */
  rule: string;
}

export interface RecordsInput {
  /** Full run history in the module 3/4 input shape. */
  runs: RunSample[];
  /** Structured workouts with their laps (module 6 input shape). */
  executions: ExecutionInput[];
  /** Weekly adherence series, e.g. from computeConsistency().weeklyBreakdown. */
  weeklyAdherence: Array<{ weekStart: LocalDate; adherence: number }>;
  /** LocalDates of every completed run in history. */
  completedRunDates: LocalDate[];
}

const MIN_EFFICIENCY_RUNS = 5;
const MIN_COMPARABLE_RUNS = 5;
const MIN_INTERVAL_WORKOUTS = 3;
const MIN_ADHERENCE_WEEKS = 8;
const BREAK_DAYS = 7;
const STREAK_LENGTH = 3;
const STREAK_MAX_GAP_DAYS = 3;

function formatPace(secPerKm: number): string {
  const total = Math.round(secPerKm);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

function bestAerobicEfficiency(runs: RunSample[]): PersonalRecord | null {
  const result = computeAerobicEfficiency(runs);
  if (result.status !== "ok" || result.sampleSize < MIN_EFFICIENCY_RUNS) return null;
  let best = result.value.perRun[0]!;
  for (const p of result.value.perRun) {
    if (p.efficiency > best.efficiency) best = p;
  }
  return {
    id: "best_aerobic_efficiency",
    title: "Best aerobic efficiency",
    value: `${best.efficiency.toFixed(2)} m/beat`,
    achievedOn: best.date,
    rule: "Highest meters travelled per heart beat on any eligible easy or recovery run of 25+ minutes with heart rate.",
  };
}

function lowestHrAtComparablePace(runs: RunSample[]): PersonalRecord | null {
  const candidates = runs.filter(
    (r) =>
      (r.category === "easy" || r.category === "recovery") &&
      r.activity.avgPaceSecPerKm != null &&
      r.activity.avgPaceSecPerKm > 0 &&
      r.activity.avgHeartRate != null &&
      r.activity.avgHeartRate > 0,
  );
  if (candidates.length === 0) return null;
  const medianPace = median(candidates.map((r) => r.activity.avgPaceSecPerKm!));
  const comparable = candidates.filter(
    (r) => Math.abs(r.activity.avgPaceSecPerKm! - medianPace) / medianPace <= 0.03,
  );
  if (comparable.length < MIN_COMPARABLE_RUNS) return null;
  let best = comparable[0]!;
  for (const r of comparable) {
    if (r.activity.avgHeartRate! < best.activity.avgHeartRate!) best = r;
  }
  return {
    id: "lowest_hr_at_comparable_pace",
    title: "Lowest heart rate at your usual easy pace",
    value: `${Math.round(best.activity.avgHeartRate!)} bpm at ${formatPace(best.activity.avgPaceSecPerKm!)}/km`,
    achievedOn: activityLocalDate(best.activity),
    rule: "Lowest average heart rate among easy runs paced within 3% of your median easy pace.",
  };
}

function mostEvenIntervalSet(executions: ExecutionInput[]): PersonalRecord | null {
  const scored: Array<{ date: LocalDate; cv: number }> = [];
  for (const e of executions) {
    const result = computeExecution(e);
    if (result.status !== "ok" || result.value.plannedWorkIntervals < 2) continue;
    scored.push({ date: e.workout.effectiveDate, cv: result.value.intervalConsistencyCvPct });
  }
  if (scored.length < MIN_INTERVAL_WORKOUTS) return null;
  scored.sort((a, b) => a.cv - b.cv || (a.date < b.date ? -1 : 1));
  const best = scored[0]!;
  return {
    id: "most_even_interval_set",
    title: "Most even interval set",
    value: `${best.cv.toFixed(1)}% pace variation`,
    achievedOn: best.date,
    rule: "Lowest coefficient of variation of work-lap paces across executed interval workouts with 2+ planned work bouts.",
  };
}

function mostConsistentFourWeeks(
  weeks: Array<{ weekStart: LocalDate; adherence: number }>,
): PersonalRecord | null {
  const sorted = [...weeks].sort((a, b) => (a.weekStart < b.weekStart ? -1 : 1));
  if (sorted.length < MIN_ADHERENCE_WEEKS) return null;
  let best: { start: LocalDate; minAdherence: number } | null = null;
  for (let i = 0; i + 3 < sorted.length; i++) {
    const window = sorted.slice(i, i + 4);
    const consecutive = window.every(
      (w, j) => j === 0 || daysBetween(window[j - 1]!.weekStart, w.weekStart) === 7,
    );
    if (!consecutive) continue;
    const minAdherence = Math.min(...window.map((w) => w.adherence));
    if (best == null || minAdherence > best.minAdherence) {
      best = { start: window[0]!.weekStart, minAdherence };
    }
  }
  if (best == null) return null;
  return {
    id: "most_consistent_four_weeks",
    title: "Most consistent four weeks",
    value: `${Math.round(best.minAdherence * 100)}% adherence in the weakest week`,
    achievedOn: addDays(best.start, 27),
    rule: "Across every stretch of 4 consecutive weeks, the highest value of the lowest weekly adherence.",
  };
}

function fastestComebackDays(completedRunDates: LocalDate[]): PersonalRecord | null {
  const dates = [...new Set(completedRunDates)].sort();
  let best: { days: number; achievedOn: LocalDate } | null = null;
  for (let i = 0; i + 1 < dates.length; i++) {
    if (daysBetween(dates[i]!, dates[i + 1]!) < BREAK_DAYS) continue;
    // A break ends at dates[i+1]; look for the first 3-run streak after it,
    // stopping if another break begins first.
    for (let j = i + 1; j + STREAK_LENGTH - 1 < dates.length; j++) {
      if (j > i + 1 && daysBetween(dates[j - 1]!, dates[j]!) >= BREAK_DAYS) break;
      const gapsOk =
        daysBetween(dates[j]!, dates[j + 1]!) <= STREAK_MAX_GAP_DAYS &&
        daysBetween(dates[j + 1]!, dates[j + 2]!) <= STREAK_MAX_GAP_DAYS;
      if (!gapsOk) continue;
      const days = daysBetween(dates[i + 1]!, dates[j + 2]!);
      if (best == null || days < best.days) best = { days, achievedOn: dates[j + 2]! };
      break;
    }
  }
  if (best == null) return null;
  return {
    id: "fastest_comeback_days",
    title: "Fastest comeback",
    value: `${best.days} days`,
    achievedOn: best.achievedOn,
    rule: "Fewest days from the first run after a break of 7+ days until three runs each within 3 days of the previous.",
  };
}

export function computeRecords(input: RecordsInput): PersonalRecord[] {
  const records: PersonalRecord[] = [];
  const push = (r: PersonalRecord | null) => {
    if (r != null) records.push(r);
  };
  push(bestAerobicEfficiency(input.runs));
  push(lowestHrAtComparablePace(input.runs));
  push(mostEvenIntervalSet(input.executions));
  push(mostConsistentFourWeeks(input.weeklyAdherence));
  push(fastestComebackDays(input.completedRunDates));
  return records;
}
